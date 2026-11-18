'use strict';

(() => {
  const el = id => document.getElementById(id);
  const panel = el('backupPanel');
  const status = el('backupStatus');
  const preview = el('backupPreview');
  const apply = el('applyBackup');
  const selected = el('backupFile');
  const auto = el('autoBrowserBackup');
  const autoKey = 'zily.backup.v1.auto';
  let pending;
  let busy = false;
  let nextAuto = 0;

  async function request(route, body, optional = false) {
    const response = await fetch('/api/memory/' + route, {
      cache: 'no-store', signal: AbortSignal.timeout(20000),
      ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (optional && response.status === 401) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '备份服务暂不可用。');
    return result;
  }
  const api = (route, body, optional) => request('backup/' + route, body, optional);
  const lock = task => ZilyStorage.withRestoreLocks([
    conversationLockName, PLAYLIST_LIBRARY_KEY, favoriteLockName, ZilyStorage.preferencesLockName,
  ], task);
  const settle = operation => api('settle', operation);

  async function guarded(task) {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    try { await task(); }
    catch (error) { status.textContent = error.name === 'QuotaExceededError' ? '浏览器空间不足，无法完成恢复。' : error.message; }
    finally { busy = false; panel.removeAttribute('aria-busy'); }
  }

  async function sha256(body) {
    const data = new TextEncoder().encode(ZilyBackup.canonical(body));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function browserData() {
    if (ZilyBackupBrowser.readJournal(localStorage)) throw new Error('请先检查未完成的恢复。');
    const control = readConversationControl();
    const { sessions, damaged } = savedConversationList(control);
    if (damaged) throw new Error('有聊天记录损坏，本次导出已暂停。');
    return ZilyBackupBrowser.collect(localStorage, control, sessions);
  }

  async function createFile(scope) {
    const browser = scope === 'all' ? await lock(browserData) : null;
    const memory = await api('export', undefined, scope === 'all');
    const body = ZilyBackup.createBody(scope, browser, memory);
    await ZilyCredentials.checkLocal({ backup: body });
    const file = { ...body, sha256: await sha256(body) };
    const json = JSON.stringify(file);
    if (new TextEncoder().encode(json).length > ZilyBackup.maxBytes) throw new Error('备份文件超过 4 MiB。');
    return { file, json };
  }

  function describe(file) {
    const { browser, memory } = file.modules;
    return [
      '备份时间 ' + new Date(file.createdAt).toLocaleString(),
      browser ? '聊天 ' + (browser.chat?.sessions.length || 0) + ' 个会话、' +
        (browser.chat?.sessions.reduce((sum, session) => sum + session.messages.length, 0) || 0) + ' 条消息' : '',
      browser ? '收藏 ' + (browser.favorites?.length || 0) + ' 首' : '',
      browser ? '歌单 ' + (browser.playlists?.playlists.length || 0) + ' 份、分类 ' + (browser.playlists?.categories.length || 0) + ' 项' : '',
      browser ? '设置 ' + (Number(browser.chat !== null) + Number(browser.preferences.companion !== null) +
        Number(browser.preferences.navigationCollapsed !== null)) + ' 组' : '',
      memory ? '正式记忆 ' + memory.memories.length + ' 条、待确认候选 ' + memory.candidates.length + ' 条' : '无长期记忆',
      memory?.suppression ? '抑制元数据：拒绝记录 ' + memory.suppression.rejected.length + ' 条、已处理标识 ' +
        memory.suppression.processed.length + ' 个、跳过标识 ' + memory.suppression.skipped.length + ' 个' : '',
      memory?.useInChat || memory?.autoExtractEnabled ? '此文件含开启的记忆引用或自动发现设置。恢复后可能向当前模型发送相关信息。' : '',
    ].filter(Boolean).join('\n');
  }

  function exportFile(scope) {
    return guarded(async () => {
      const { file, json } = await createFile(scope);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'music-companion-' + scope + '-' + file.createdAt.replace(/[:.]/g, '-') + '.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status.textContent = '已生成备份。文件含私人内容，请妥善保管。';
      preview.textContent = describe(file);
      pending = undefined;
      apply.disabled = true;
    });
  }

  async function inspect(body) {
    const { browser, memory } = body.modules;
    const local = await lock(() => ZilyBackupBrowser.plan(localStorage, browser, browser ? readConversationControl() : null, () => crypto.randomUUID()));
    const state = memory ? await api('state', undefined, true) : null;
    if (memory && state && (state.occupied || (state.useInChat && !memory.useInChat) ||
        (state.autoExtractEnabled && !memory.autoExtractEnabled))) local.conflicts.push('长期记忆或其设置已有数据');
    return { local, state };
  }

  el('openBackup').onclick = () => panel.showPopover();
  el('exportAllBackup').onclick = () => exportFile('all');
  el('exportMemoryBackup').onclick = () => exportFile('memory');
  selected.onchange = () => guarded(async () => {
    pending = undefined;
    apply.disabled = true;
    preview.textContent = '';
    const file = selected.files[0];
    if (!file) return;
    if (file.size > ZilyBackup.maxBytes) throw new Error('备份文件超过 4 MiB。');
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('备份不是有效的 JSON 文件。'); }
    const { body, sha256: checksum } = ZilyBackup.split(data);
    if (await sha256(body) !== checksum) throw new Error('备份完整性校验失败。');
    await ZilyCredentials.checkLocal({ backup: body });
    const { local, state } = await inspect(body);
    preview.textContent = describe(body) + '\n' + (local.conflicts.length ? '存在冲突 · ' + local.conflicts.join('、') :
      '检查完成。现有记录将保留。' + (body.modules.memory && !state ? '确认后将创建新的长期记忆身份。' : ''));
    if (body.modules.memory) {
      const counts = state?.suppression;
      preview.textContent += '\n拒绝记录按有效期合并，消息标识去重。目标已有有效拒绝记录 ' +
        (counts?.rejected || 0) + ' 条、去重标识 ' + ((counts?.processed || 0) + (counts?.skipped || 0)) + ' 个。';
      const memory = body.modules.memory;
      const cleared = state?.clearEpoch && (memory.lineage !== state.lineage || (memory.clearEpoch || 0) < state.clearEpoch);
      const ids = new Set(state?.deletion?.ids || []);
      const messages = new Set(state?.deletion?.messages || []);
      const blocked = [...memory.memories, ...memory.candidates].filter(item => cleared || ids.has(item.id) ||
        (item.evidence || []).some(entry => messages.has(entry.messageId))).length;
      if (blocked) preview.textContent += '\n目标库的删除或清空记录会阻止 ' + blocked + ' 条旧记忆或候选导入。';
    }
    if (!local.conflicts.length) { pending = { body, state }; apply.disabled = false; }
  });

  apply.onclick = () => guarded(async () => {
    if (!pending || !confirm('按预览恢复？已有记录会保留。')) return;
    const { body, state } = pending;
    const memory = body.modules.memory;
    const result = await lock(async () => {
      const data = body.modules.browser;
      const plan = ZilyBackupBrowser.plan(localStorage, data, data ? readConversationControl() : null, () => crypto.randomUUID());
      if (plan.conflicts.length) throw new Error('预览后出现冲突 · ' + plan.conflicts.join('、'));
      let operation = null;
      if (memory) {
        const id = crypto.randomUUID();
        if (state) operation = { id, target: state.target, expected: state.expected };
        else {
          const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
          operation = { id, proof, issuedAt: Date.now() };
        }
      }
      return ZilyBackupBrowser.restore({ storage: localStorage, writes: plan.writes, operation, memory,
        send: data => api('restore', data), settle });
    });
    pending = undefined;
    apply.disabled = true;
    status.textContent = '恢复完成。已写入 ' + result.writes + ' 项浏览器存储。' +
      (memory ? '长期记忆已处理，目标库的删除及抑制记录已保留。' : '') +
      '请刷新页面以载入恢复后的数据。';
  });

  async function checkPending() {
    if (localStorage.getItem(ZilyBackupBrowser.journalKey) === null) return;
    const result = await lock(() => ZilyBackupBrowser.reconcile(localStorage, settle));
    if (result?.retainedLegacy) {
      status.textContent = '旧版恢复日志缺少写入归属，已保留可能受影响的浏览器数据。请检查这些数据。';
    } else if (result) {
      status.textContent = result.committed
        ? '上次恢复已提交。请刷新页面以载入恢复后的数据。'
        : '已撤销上次中断的恢复，原有资料已保留。请刷新页面。';
    }
  }
  el('checkBackupRecovery').onclick = () => guarded(async () => {
    if (localStorage.getItem(ZilyBackupBrowser.journalKey) === null) status.textContent = '没有未完成的恢复。';
    else await checkPending();
  });

  el('setupBackupRecovery').onclick = () => guarded(async () => {
    if (ZilyBackupBrowser.readJournal(localStorage)) throw new Error('请先检查未完成的恢复。');
    if (!confirm('为当前长期记忆库设置或更换恢复口令？')) return;
    const field = el('setupRecoveryPassword');
    const password = field.value;
    field.value = '';
    const result = await api('recovery-setup', { password, confirm: true });
    el('backupRecoveryId').value = result.recoveryId;
    status.textContent = '恢复口令已设置。请单独保存恢复编号和口令。';
  });
  el('recoverBackupIdentity').onclick = () => guarded(async () => {
    if (ZilyBackupBrowser.readJournal(localStorage)) throw new Error('请先检查未完成的恢复。');
    if (!confirm('用恢复编号连接原资料库？原库的旧浏览器身份将失效。')) return;
    const field = el('recoverPassword');
    const password = field.value;
    field.value = '';
    await api('recover', { recoveryId: el('recoverId').value.trim().toLowerCase(), password, confirm: true });
    status.textContent = '已连接原资料库。请刷新页面。';
  });

  async function runAuto(showError = false) {
    if (!auto.checked || busy || Date.now() < nextAuto) return;
    nextAuto = Date.now() + 60 * 60_000;
    const task = async () => {
      if (!await api('state', undefined, true)) throw new Error('请先启用长期记忆身份，再开启浏览器自动备份。');
      const { file } = await createFile('all');
      const result = await api('auto', { file });
      nextAuto = Date.now() + Math.max(60 * 60_000, result.nextAfterMs || 0);
      if (showError) status.textContent = (result.saved ? '本机自动备份已写入。' : '已有有效备份，自动备份已开启。') +
        (result.damaged ? '发现旧备份损坏，已保留以供检查。' : '');
    };
    if (showError) await guarded(task);
    else try { await task(); } catch { /* The next scheduled run can retry. */ }
  }
  auto.onchange = async () => {
    try {
      if (auto.checked && !await api('state', undefined, true)) throw new Error('请先启用长期记忆身份，再开启浏览器自动备份。');
      localStorage.setItem(autoKey, String(auto.checked));
      if (auto.checked) { nextAuto = 0; await runAuto(true); }
    } catch (error) {
      auto.checked = localStorage.getItem(autoKey) === 'true';
      status.textContent = error.message;
    }
  };
  try { auto.checked = localStorage.getItem(autoKey) === 'true'; }
  catch { auto.disabled = true; }
  if (auto.checked) void runAuto();
  setInterval(() => void runAuto(), 60 * 60_000);
  void guarded(checkPending);
})();
