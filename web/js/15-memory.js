'use strict';

{
  const categories = {
    profile: '个人资料', preference: '偏好', music: '音乐', experience: '经历',
    decision: '决定', topic: '话题', goal: '目标', task: '待办'
  };
  const kinds = {
    user_fact: '用户事实', user_opinion: '用户观点', user_preference: '用户偏好',
    confirmed_decision: '已确认决定', manual_note: '手动笔记'
  };
  const element = id => document.getElementById(id);
  const panel = element('memoryPanel');
  const form = element('memoryForm');
  const list = element('memoryList');
  const filter = element('memoryFilter');
  const search = element('memorySearch');
  const errorText = element('memoryError');
  const retry = element('retryMemory');
  const category = element('memoryCategory');
  const kind = element('memoryKind');
  const content = element('memoryContent');
  let items = [];
  let editing = null;
  let editingCandidate = false;
  let autoSetting = null;
  const autoToggle = element('memoryAutoExtract');
  let busy = false;
  let candidateRefreshPending = false;
  let schemaVersion;

  function addOptions(select, labels) {
    for (const [value, label] of Object.entries(labels)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  }

  addOptions(filter, categories);
  addOptions(category, categories);
  addOptions(kind, kinds);

  async function request(path, method = 'GET', body) {
    const options = { method, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch('/api/memory/' + path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || '长期记忆请求失败，请稍后再试。');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function setError(message) {
    errorText.textContent = message;
    errorText.hidden = !message;
  }

  function clearForm() {
    editing = null;
    editingCandidate = false;
    form.reset();
    form.hidden = true;
  }

  function openForm(item = null, candidate = false) {
    if (busy) return;
    editing = item;
    editingCandidate = candidate;
    element('memoryFormTitle').textContent = candidate ? '编辑后保存待确认记忆' : item ? '编辑记忆' : '添加记忆';
    content.value = item?.content || '';
    category.value = item?.category || 'profile';
    kind.value = item?.kind || 'manual_note';
    form.hidden = false;
    content.focus();
  }

  function renderItem(item) {
    const row = document.createElement('li');
    const labels = document.createElement('p');
    labels.className = 'memory-hint';
    labels.textContent = (categories[item.category] || item.category) + ' · ' + (kinds[item.kind] || item.kind);
    const text = document.createElement('p');
    text.className = 'memory-content';
    text.textContent = item.content;
    const actions = document.createElement('div');
    actions.className = 'memory-actions';
    for (const [label, handler] of [['编辑', () => openForm(item)], ['删除', () => removeItem(item)]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mood-chip';
      button.textContent = label;
      button.addEventListener('click', handler);
      actions.append(button);
    }
    row.append(labels, text, actions);
    return row;
  }

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = items.filter(item => (!filter.value || item.category === filter.value) &&
      (!query || item.content.toLocaleLowerCase().includes(query)));
    list.replaceChildren(...matches.map(renderItem));
    const empty = element('memoryEmpty');
    empty.hidden = matches.length > 0;
    empty.textContent = items.length ? '没有符合条件的记忆。' : '还没有记忆。可以添加第一条。';
  }

  const useToggle = element('memoryUseInChat');
  let useInChat = false;

  function showUseSetting(enabled) {
    useInChat = enabled;
    useToggle.checked = enabled;
    element('memoryUseStatus').textContent = enabled ? '已开启' : '已关闭';
  }

  function showAutoSetting(setting) {
    autoSetting = setting;
    autoToggle.checked = setting?.autoExtractEnabled === true;
    if (typeof setMemoryDiscovery === 'function') setMemoryDiscovery(setting);
  }

  async function reviewCandidate(id, action, fields) {
    await request('candidates', 'POST', fields ? { id, action, fields } : { id, action });
    if (editingCandidate && editing?.id === id) clearForm();
    if (panel.matches(':popover-open')) await waitForPanelRequests(loadCandidates(), loadItems());
  }

  function renderCandidate(item) {
    const row = document.createElement('li');
    const label = document.createElement('p');
    label.className = 'memory-hint';
    label.textContent = (categories[item.category] || item.category) + ' · ' + new Date(item.createdAt).toLocaleString();
    const text = document.createElement('p');
    text.className = 'memory-content';
    text.textContent = item.content;
    const quote = document.createElement('p');
    quote.className = 'memory-hint memory-content';
    quote.textContent = '原话：' + item.evidence.map(evidence => evidence.quote).join(' / ');
    const reason = document.createElement('p');
    reason.className = 'memory-hint';
    reason.textContent = '发现理由：' + item.reason;
    const actions = document.createElement('div');
    actions.className = 'memory-actions';
    for (const [name, handler] of [
      ['保存', () => void run(() => reviewCandidate(item.id, 'save'))],
      ['编辑后保存', () => openForm(item, true)],
      ['暂不保存', () => void run(() => reviewCandidate(item.id, 'reject'))],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mood-chip';
      button.textContent = name;
      button.addEventListener('click', handler);
      actions.append(button);
    }
    row.append(label, text, quote, reason);
    const relationLabels = {
      possible_duplicate: '可能重复',
      possible_supplement: '可能补充',
      possible_conflict: '可能冲突',
      related_unresolved: '有关联，关系待判断',
    };
    for (const relation of [item.relation, item.relation?.other]) {
      if (!relation?.target || !Object.hasOwn(relationLabels, relation.type)) continue;
      const related = document.createElement('div');
      related.className = 'memory-related';
      const heading = document.createElement('p');
      heading.className = 'memory-hint';
      const source = relation.target.source === 'pending' ? '另一条待确认记忆' : '已有正式记忆';
      heading.textContent = source + ' · ' + relationLabels[relation.type];
      const existing = document.createElement('p');
      existing.className = 'memory-content';
      existing.textContent = relation.target.content;
      const basis = document.createElement('p');
      basis.className = 'memory-hint';
      basis.textContent = relation.reason;
      related.append(heading, existing, basis);
      row.append(related);
    }
    row.append(actions);
    return row;
  }

  async function loadCandidates() {
    if (!panel.matches(':popover-open')) return;
    candidateRefreshPending = false;
    const data = await request('candidates');
    element('memoryCandidates').replaceChildren(...data.items.map(renderCandidate));
    element('memoryCandidatesEmpty').hidden = data.items.length > 0;
  }

  async function waitForPanelRequests(...requests) {
    // Keep the panel busy until parallel reads settle, including after one fails.
    const results = await Promise.allSettled(requests);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(result => result.value);
  }

  async function loadEnabledPanel() {
    const [settings, discovery] = await waitForPanelRequests(
      request('settings'), request('discovery'), loadItems(), loadCandidates()
    );
    showAutoSetting(discovery);
    showUseSetting(settings.useInChat === true);
    element('memoryEnabled').hidden = false;
  }

  async function loadItems() {
    const data = await request('items');
    items = data.items;
    element('clearMemories').hidden = false;
    element('memoryStatus').textContent = '已启用 · 共 ' + data.total + ' 条记忆' +
      (schemaVersion ? ' · 资料库版本 ' + schemaVersion : '');
    renderList();
  }

  async function run(action, preserveError = false) {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    if (!preserveError) {
      setError('');
      retry.hidden = true;
    }
    try {
      await action();
    } catch (error) {
      if (error.status === 401) {
        candidateRefreshPending = false;
        clearForm();
        showAutoSetting(null);
        items = [];
        list.replaceChildren();
        element('memoryEnabled').hidden = true;
        element('memoryDisabled').hidden = false;
        element('memoryStatus').textContent = '未启用或身份已失效';
      }
      if (!preserveError || errorText.hidden || error.status === 401) {
        setError(error.message || '暂时无法操作长期记忆。');
      }
      retry.hidden = false;
    } finally {
      busy = false;
      panel.setAttribute('aria-busy', 'false');
      flushCandidateRefresh();
    }
  }

  async function loadPanel() {
    element('memoryDisabled').hidden = true;
    element('memoryEnabled').hidden = true;
    element('memoryStatus').textContent = '正在读取状态…';
    clearForm();
    items = [];
    list.replaceChildren();
    const status = await request('status');
    if (status.enabled) {
      schemaVersion = status.schemaVersion;
      await loadEnabledPanel();
    } else {
      element('memoryStatus').textContent = '未启用';
      element('memoryDisabled').hidden = false;
    }
  }

  async function changeItems(action, success) {
    await run(async () => {
      const result = await action();
      if (success) success();
      try {
        if (Number.isSafeInteger(result?.epoch)) {
          if (typeof setMemoryDiscovery === 'function') setMemoryDiscovery(null);
          showAutoSetting(await request('discovery'));
          await loadCandidates();
        }
        await loadItems();
      } catch { throw new Error('操作已保存，但列表未能刷新。请重新加载确认。'); }
    });
  }

  function removeItem(item) {
    if (busy || !confirm('删除这条长期记忆？此操作无法撤销。')) return;
    void changeItems(() => request('items/' + item.id, 'DELETE', { revision: item.revision }), () => {
      if (editing?.id === item.id) clearForm();
    });
  }

  function flushCandidateRefresh() {
    if (!panel.matches(':popover-open')) candidateRefreshPending = false;
    if (candidateRefreshPending && !busy) void run(loadCandidates, true);
  }

  panel.addEventListener('toggle', event => {
    if (event.newState === 'open') void run(loadPanel);
    else candidateRefreshPending = false;
  });
  retry.addEventListener('click', () => void run(loadPanel));
  element('enableMemory').addEventListener('click', () => void run(async () => {
    const status = await request('activate', 'POST');
    element('memoryDisabled').hidden = true;
    schemaVersion = status.schemaVersion;
    await loadEnabledPanel();
  }));
  autoToggle.addEventListener('change', () => {
    const enabled = autoToggle.checked;
    autoToggle.checked = autoSetting?.autoExtractEnabled === true;
    if (busy) return;
    autoToggle.disabled = true;
    if (!enabled && typeof setMemoryDiscovery === 'function') setMemoryDiscovery(null);
    void run(async () => {
      try { showAutoSetting(await request('discovery', 'PATCH', { autoExtractEnabled: enabled })); }
      catch (error) {
        // Until settings are refreshed, a failed save leaves collection paused.
        if (typeof setMemoryDiscovery === 'function') setMemoryDiscovery(null);
        throw error;
      }
    }).finally(() => { autoToggle.disabled = false; });
  });
  document.addEventListener?.('memory-candidates-updated', () => {
    if (!panel.matches(':popover-open')) return;
    candidateRefreshPending = true;
    flushCandidateRefresh();
  });
  useToggle.addEventListener('change', () => {
    const enabled = useToggle.checked;
    useToggle.checked = useInChat;
    if (busy) return;
    useToggle.disabled = true;
    void run(async () => {
      const saved = await request('settings', 'PATCH', { useInChat: enabled });
      showUseSetting(saved.useInChat === true);
    }).finally(() => { useToggle.disabled = false; });
  });
  filter.addEventListener('change', renderList);
  search.addEventListener('input', renderList);
  element('addMemory').addEventListener('click', () => openForm());
  element('cancelMemory').addEventListener('click', () => { if (!busy) clearForm(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const draft = { category: category.value, kind: kind.value, content: content.value };
    const current = editing;
    if (editingCandidate) {
      void run(() => reviewCandidate(current.id, 'save', draft));
      return;
    }
    void changeItems(() => current
      ? request('items/' + current.id, 'PATCH', { ...draft, revision: current.revision })
      : request('items', 'POST', { ...draft, ...(autoSetting?.clearEpoch ? { clearEpoch: autoSetting.clearEpoch } : {}) }), clearForm);
  });
  element('clearMemories').addEventListener('click', () => {
    if (busy || !confirm('确定永久清空正式长期记忆和所有待确认候选？进行中的提取结果也会作废。本机自动备份中的相应记忆会清除，聊天记录、收藏、播放历史和用于防止重复提取的标识会保留。已下载的文件需自行处理。')) return;
    void changeItems(() => request('items', 'DELETE', { confirm: true, ...(autoSetting?.clearEpoch ? { clearEpoch: autoSetting.clearEpoch } : {}) }), clearForm);
  });
}
