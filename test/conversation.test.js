'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { CORE_PERSONA, buildPersonaPrompt } = require('../server/persona');

const scripts = ['00-storage-coordination.js', '00-credentials.js', '09-chat.js', '12-conversation.js'].map(name =>
  readFileSync(join(__dirname, '../web/js', name), 'utf8'));
const chatKey = 'zily.conversation';
const saveKey = 'zily.saveConversation';


const controlKey = 'zily.conversation.v2.control';
const sessionPrefix = 'zily.conversation.v2.session.';
const lockTails = new WeakMap();

function snapshotEntries(storage) {
  return [...storage].filter(([key]) => key.startsWith(sessionPrefix))
    .map(([key, value]) => [key, JSON.parse(value)]);
}

function snapshot(storage, id) {
  const entries = snapshotEntries(storage);
  return id ? entries.find(([, record]) => record.sessionId === id)?.[1] : entries.at(-1)?.[1];
}

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

function boot(storage = new Map(), fetch, { write, locks = true } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const visible = [];
  const node = () => ({
    isConnected: true, children: [], textContent: '',
    replaceChildren(...children) { this.children = children; },
    querySelector() { return this; },
    append(...children) { this.children.push(...children); },
  });
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const context = vm.createContext({
    AbortController, AbortSignal, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    fetch: (url, options) => url === '/api/privacy/check' ? Promise.resolve(new Response(null, { status: 204 })) : fetch(url, options),
    crypto: { randomUUID },
    CHAT_API: '/api/chat', chatContext: [], companionMode: 'listen',
    companionPreferences: { length: 'short', suggestMusic: false },
    document: { getElementById: get, createElement: node, addEventListener: (event, listener) => listeners.set(event, listener) },
    addEventListener: (event, listener) => listeners.set(event, listener),
    chatMsgs: node(), chatInput: { focus() {} },
    confirm: () => true,
    navigator: { locks: locks ? { request(name, task) {
      assert.equal(name, 'zily.conversation.v2');
      const next = (lockTails.get(storage) || Promise.resolve()).then(task);
      lockTails.set(storage, next.catch(() => {}));
      return next;
    } } : undefined },
    localStorage: {
      get length() { return storage.size; },
      key: index => [...storage.keys()][index] ?? null,
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) { write?.(key, value); storage.set(key, value); },
      removeItem: key => storage.delete(key)
    }
  });
  scripts.forEach(script => vm.runInContext(script, context));
  context.addUMsg = text => visible.push(text);
  context.addAIMsg = node;
  context.setAIMessageText = (container, text) => {
    container.textContent = text;
    container.children = [];
    visible.push(text);
  };
  context.appendConversationTurn = (user, reply) => {
    const turn = context.beginConversationTurn(user);
    turn[1].content = reply;
    context.finishConversationTurn(turn, 'completed');
  };
  return { context, get, node, visible, listeners, ready: () => vm.runInContext('conversationStartup', context) };
}

test('browser blocks credential input before rendering, model calls or conversation storage', async () => {
  const key = 'sk-' + 'F'.repeat(30);
  const storage = new Map([[saveKey, 'true']]);
  let requests = 0;
  const tab = boot(storage, async () => { requests++; throw new Error('unexpected model request'); });
  await tab.ready();
  const warnings = [];
  tab.context.addErrMsg = text => warnings.push(text);
  await tab.context.sendMessage(false, key);
  assert.equal(requests, 0);
  assert.equal(snapshotEntries(storage).length, 0);
  assert.match(warnings[0], /疑似凭证/);
  assert.equal(warnings[0].includes(key), false);
});

test('browser checkpoint and subsequent saves redact messages and summaries', async () => {
  const key = 'sk-' + 'F'.repeat(30);
  const storage = new Map([[saveKey, 'true']]);
  const tab = boot(storage);
  await tab.ready();
  tab.context.appendConversationTurn('普通问题', '可能的私钥 ' + key);
  tab.context.fixtureSecret = key;
  vm.runInContext('conversationSummary = { text: fixtureSecret, covered: 2 }', tab.context);
  await tab.context.flushConversationCheckpoint();
  await tab.context.saveConversation();
  const saved = snapshot(storage);
  assert.equal(JSON.stringify(saved).includes(key), false, 'credential present in a browser snapshot');
  assert.equal(saved.messages[1].content, '[凭证已隐藏]');
  assert.equal(saved.summary.text, '[凭证已隐藏]');
});

function addTurns(context, count) {
  for (let index = 0; index < count; index++) {
    context.appendConversationTurn('问题 ' + index, '回复 ' + index);
  }
}

function sse(text, ending = 'data: [DONE]\n\n') {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n' + ending);
}

test('summary receives both real roles and keeps guesses separate from facts in its instructions', async () => {
  const requests = [];
  const { context } = boot(new Map(), async (_, { body }) => {
    requests.push(JSON.parse(body));
    return sse('双方讨论：子夜猜测是预算问题，尚未证实。用户事实：周五交稿。');
  });
  context.appendConversationTurn('周五交稿。', '可能是预算的问题。');
  addTurns(context, 5);
  await context.refreshConversationSummary();
  assert.equal(requests[0].mode, 'summary');
  assert.deepEqual(requests[0].messages, [
    { role: 'user', content: '周五交稿。' },
    { role: 'assistant', content: '可能是预算的问题。' }
  ]);
  assert.match(buildPersonaPrompt('summary'), /不得把子夜的猜测当成用户事实/);
  assert.match(buildPersonaPrompt('summary'), /接受、拒绝或修正/);
  assert.ok(buildPersonaPrompt('listen').startsWith(CORE_PERSONA));
  assert.match(vm.runInContext('conversationSummary.text', context), /尚未证实/);
});

test('covered turns are excluded from future requests and not summarized again', async () => {
  const { context } = boot();
  const batches = [];
  context.streamChatMessages = async messages => {
    batches.push(Array.from(messages, message => message.content));
    return '当前话题：海报。';
  };
  addTurns(context, 6);
  await context.refreshConversationSummary();
  assert.equal(context.conversationMessages()[0].content, '问题 1');
  addTurns(context, 2);
  await context.refreshConversationSummary();
  assert.equal(batches.length, 2);
  assert.match(batches[1][0], /旧摘要/);
  assert.deepEqual(batches[1].slice(1), ['问题 1', '回复 1', '问题 2', '回复 2']);
  assert.equal(context.conversationMessages()[0].content, '问题 3');
});

test('multibyte long history stays within 64 KiB and leaves the latest message intact', async () => {
  let request;
  const { context } = boot(new Map(), async (_, { body }) => {
    request = body;
    return sse('收到');
  });
  for (let i = 0; i < 9; i++) context.appendConversationTurn('问题' + i + '字'.repeat(5997), '回复' + i + '字'.repeat(5997));
  const latest = '  ' + '月'.repeat(7995) + '。  ';
  assert.equal(latest.length, 8000);
  assert.equal(await context.callAIStream(latest), '收到');
  assert.ok(Buffer.byteLength(request) <= 64 * 1024);
  const { messages } = JSON.parse(request);
  assert.equal(messages.at(-1).content, latest);
  assert.equal(messages.length, 3);
  assert.match(messages[0].content, /^问题8/);
  assert.match(messages[1].content, /^回复8/);
  await assert.rejects(context.callAIStream(latest + '字'), /太长/);
});

test('failed and successful summaries both preserve all raw messages', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const { context } = boot(storage, async () => sse('只有半段', ''));
  addTurns(context, 45);
  await context.refreshConversationSummary();
  assert.equal(context.chatContext.length, 90);
  assert.equal(context.chatContext[0].content, '问题 0');
  await context.saveConversation();
  const reloaded = boot(storage);
  await reloaded.get('resumeConversation').onclick();
  assert.equal(reloaded.context.chatContext.length, 90);
  assert.equal(reloaded.context.chatContext[0].content, '问题 0');
  assert.equal(vm.runInContext('conversationSummary.covered', context), 0);
  context.streamChatMessages = async () => { throw Error('mock failed'); };
  await context.refreshConversationSummary();
  assert.equal(context.chatContext.length, 90);
  context.streamChatMessages = async () => '当前话题：工作。';
  await context.refreshConversationSummary();
  assert.equal(context.chatContext.length, 90);
  assert.equal(context.chatContext[0].content, '问题 0');
  assert.equal(vm.runInContext('conversationSummary.covered', context), 20);
});

test('a delayed summary does not block chat and cannot enter a new conversation', async () => {
  let finishSummary;
  let summarySignal;
  const { context, get } = boot();
  addTurns(context, 6);
  context.streamChatMessages = async (messages, _, signal, maxTokens, temperature, options) => {
    if (options.mode !== 'summary') return '本轮正常回复';
    summarySignal = signal;
    return new Promise(resolve => { finishSummary = resolve; });
  };
  const pending = context.refreshConversationSummary();
  const result = await context.callAIStream('先继续聊');
  assert.equal(result, '本轮正常回复');
  get('newConversation').onclick();
  assert.equal(summarySignal.aborted, true);
  context.appendConversationTurn('新会话', '新的回复');
  finishSummary('只属于旧会话');
  await pending;
  assert.equal(vm.runInContext('conversationSummary.text', context), '');
  assert.equal(context.chatContext[0].content, '新会话');
});

test('legacy arrays and text summaries restore, while new chats and deletion clear active context', async () => {
  const messages = [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回复' }];
  for (const stored of [messages, { messages, summary: { text: '旧摘要', covered: 2 } }]) {
    const storage = new Map([[saveKey, 'true'], [chatKey, JSON.stringify(stored)]]);
    const { context, get } = boot(storage);
    assert.equal(context.chatContext.length, 0);
    await get('resumeConversation').onclick();
    assert.equal(context.chatContext.length, 2);
    assert.equal(vm.runInContext('conversationSummary.text', context), stored.summary?.text || '');
    get('newConversation').onclick();
    assert.equal(vm.runInContext('conversationSummary.text', context), '');
    await get('resumeConversation').onclick();
    await get('deleteConversation').onclick();
    assert.equal(storage.has(chatKey), false);
    assert.equal(context.chatContext.length, 0);
    assert.equal(vm.runInContext('conversationSummary.text', context), '');
  }
});

test('saved summaries survive reload, and switching saving off removes persisted conversation', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const first = boot(storage);
  addTurns(first.context, 6);
  first.context.streamChatMessages = async () => '当前话题：测试。';
  await first.context.refreshConversationSummary();
  const next = boot(storage);
  await next.get('resumeConversation').onclick();
  assert.equal(next.context.conversationMessages().length, 10);
  assert.equal(vm.runInContext('conversationSummary.text', next.context), '当前话题：测试。');
  const toggle = next.get('saveConversation');
  toggle.checked = false;
  await toggle.onchange();
  assert.equal(storage.has(chatKey), false);
  assert.equal(next.context.chatContext.length, 12);
  assert.equal(boot(storage).get('resumeConversation').disabled, true);
});

test('long chats keep sending bounded complete turns while preserving the raw archive', async () => {
  let summaryCount = 0;
  const { context } = boot(new Map(), async (_, { body }) => {
    assert.ok(Buffer.byteLength(body) <= 64 * 1024);
    const { mode, messages } = JSON.parse(body);
    if (mode === 'summary') {
      summaryCount++;
      return sse('当前话题：持续讨论。');
    }
    assert.ok(messages.length <= 19);
    assert.equal(messages.at(-1).role, 'user');
    return sse('接着聊。');
  });
  for (let turn = 0; turn < 55; turn++) {
    const input = '第 ' + turn + ' 轮';
    const answer = await context.callAIStream(input);
    context.appendConversationTurn(input, answer);
    await context.refreshConversationSummary();
  }
  assert.ok(summaryCount > 1);
  assert.equal(context.chatContext.length, 110);
  assert.equal(context.chatContext.at(-2).content, '第 54 轮');
});
test('natural artist requests and confirmations route through chat to the playback directive', async () => {
  const modes = [];
  const played = [];
  const { context } = boot(new Map(), async (_, { body }) => {
    modes.push(JSON.parse(body).mode);
    return sse('放《迟迟》。[JSON_START]{"song":"迟迟","artist":"薛之谦"}[JSON_END]');
  });
  context.addAIMsg = () => ({ isConnected: true });
  context.getRecentPlayedList = () => '';
  context.applyMusicReply = async (raw, intent, daily) => {
    const { clean, tag } = context.parseSongDirective(raw);
    assert.equal(intent.type, 'play');
    played.push([tag.song, tag.artist, daily]);
    return clean;
  };
  for (const input of ['我现在想听薛之谦的歌曲', '放啊', '怎么不播放迟迟']) {
    context.chatInput.value = input;
    await context.sendMessage();
  }
  assert.deepEqual(modes, ['music', 'music', 'music']);
  assert.deepEqual(played, Array.from({ length: 3 }, () => ['迟迟', '薛之谦', false]));
});
test('current named shows and grounded lookup requests use search while music discussion stays in chat', async () => {
  const titleQuestion = '最近有个综艺很火，叫做《虚构节目》，你怎么看待这个综艺';
  const followUp = '那你现在去关注一些';
  const calls = [];
  const messages = [];
  const tab = boot(new Map(), async (url, { body }) => {
    calls.push([url, JSON.parse(body)]);
    if (url !== '/api/search') return sse('这首歌的编曲很轻快。');
    return Response.json({ answer: '这是模拟查到的节目资料。', results: [{ title: '节目官网', url: 'https://example.invalid/show' }] });
  });
  await tab.ready();
  tab.context.addAIMsg = () => {
    const bubble = tab.node();
    messages.push(bubble);
    return bubble;
  };
  await tab.context.sendMessage(false, titleQuestion);
  await tab.context.sendMessage(false, followUp);
  await tab.context.sendMessage(false, '帮我查一下《虚构歌曲》的发行时间');
  await tab.context.sendMessage(false, '聊聊《虚构歌曲》的编曲');

  assert.deepEqual(calls.map(([url]) => url), ['/api/search', '/api/search', '/api/search', '/api/chat']);
  assert.deepEqual(calls[0][1], { query: titleQuestion, context: [] });
  assert.deepEqual(calls[1][1], {
    query: followUp,
    context: [
      { role: 'user', content: titleQuestion },
      { role: 'assistant', content: '这是模拟查到的节目资料。' }
    ]
  });
  assert.equal(messages[0].children[0].children[0].textContent, '来源（1）');
  assert.equal(calls[3][1].mode, 'music');
});

function chunk(delta = {}, finishReason = null, newline = '\n\n') {
  return 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] }) + newline;
}

test('only successfully completed ordinary SSE turns enter discovery and saved IDs survive resume', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const queued = [];
  let complete = true;
  const { context, get } = boot(storage, async () => complete
    ? sse('普通回复。')
    : new Response(chunk({ content: '部分回复。' }, 'length')));
  context.queueMemoryTurn = (sessionId, turn) => queued.push({ sessionId, turn });
  context.getRecentPlayedList = () => '';
  const container = context.addAIMsg();
  await context.runChatReply('我喜欢钢琴独奏。', false, null, container);
  complete = false;
  await context.runChatReply('这轮不完整。', false, null, container);
  complete = true;
  await context.runChatReply('来首歌。', true, null, container);
  assert.equal(queued.length, 1);
  const original = snapshot(storage);
  assert.equal(original.sessionId, queued[0].sessionId);
  assert.equal(original.messages[0].id, queued[0].turn[0].id);
  assert.notEqual(original.messages[0].id, original.messages[1].id);
  const resumed = boot(storage);
  await resumed.get('resumeConversation').onclick();
  assert.equal(vm.runInContext('conversationId', resumed.context), original.sessionId);
  assert.equal(resumed.context.chatContext[0].id, original.messages[0].id);
  get('newConversation').onclick();
  assert.notEqual(vm.runInContext('conversationId', context), original.sessionId);
});

function summaryState(context) {
  return JSON.parse(vm.runInContext('JSON.stringify(conversationSummary)', context));
}

test('summary joins formal fragments and ignores reasoning-only chunks', async () => {
  const stream = chunk({ content: '', reasoning_content: '不能出现在摘要中的思考' })
    + chunk({ content: '当前话题：', reasoning_content: '也不能保存' })
    + chunk({ content: '蓝鲸海报。' }, 'stop') + 'data: [DONE]\n\n';
  const { context } = boot(new Map(), async () => new Response(stream));
  addTurns(context, 6);
  await context.refreshConversationSummary();
  assert.deepEqual(summaryState(context), { text: '当前话题：蓝鲸海报。', covered: 2 });
});

test('DONE cancels an open response and releases the reader without waiting for cancellation', { timeout: 1000 }, async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunk({ content: '可提交。' }) + 'data: [DONE]\n\n'));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    }
  });
  const { context } = boot(new Map(), async () => new Response(body));
  addTurns(context, 6);
  await context.refreshConversationSummary();
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(summaryState(context).text, '可提交。');
});

test('finish_reason stop completes a summary without DONE', async () => {
  const { context } = boot(new Map(), async () => new Response(chunk({ content: '完成。' }, 'stop')));
  addTurns(context, 6);
  await context.refreshConversationSummary();
  assert.deepEqual(summaryState(context), { text: '完成。', covered: 2 });
});

test('length and other abnormal finishes cannot commit even if DONE follows', async () => {
  for (const reason of ['length', 'content_filter']) {
    const { context } = boot(new Map(), async () => new Response(
      chunk({ content: '部分正文' }, reason) + 'data: [DONE]\n\n'));
    addTurns(context, 8);
    vm.runInContext("conversationSummary = { text: '上一次成功的摘要。', covered: 2 }", context);
    const before = JSON.stringify(context.chatContext);
    await context.refreshConversationSummary();
    assert.deepEqual(summaryState(context), { text: '上一次成功的摘要。', covered: 2 });
    assert.equal(JSON.stringify(context.chatContext), before);
  }
});

test('EOF flushes an un-terminated DONE line and the final valid content event', async () => {
  for (const stream of [
    chunk({ content: '可提交。' }) + 'data: [DONE]',
    chunk({ content: '可提交。' }, 'stop', '')
  ]) {
    const { context } = boot(new Map(), async () => new Response(stream));
    addTurns(context, 6);
    await context.refreshConversationSummary();
    assert.deepEqual(summaryState(context), { text: '可提交。', covered: 2 });
  }
});

test('an incomplete final JSON line is not treated as a valid stop or as content', async () => {
  const { context } = boot(new Map(), async () => new Response(
    chunk({ content: '只有半段' }) + 'data: {"choices":[{"finish_reason":"stop"'));
  addTurns(context, 6);
  await context.refreshConversationSummary();
  assert.deepEqual(summaryState(context), { text: '', covered: 0 });
  assert.equal(context.chatContext.length, 12);
});

test('reasoning-only and oversized summaries do not commit', async () => {
  for (const delta of [
    { content: '', reasoning_content: '不是正文' },
    { content: '字'.repeat(1201) }
  ]) {
    const { context } = boot(new Map(), async () => new Response(chunk(delta, 'stop')));
    addTurns(context, 6);
    await context.refreshConversationSummary();
    assert.deepEqual(summaryState(context), { text: '', covered: 0 });
  }
});

test('30-second summary timeout aborts a stalled read, clears its timer and preserves history', async () => {
  let fireTimeout;
  let requestSignal;
  let stream;
  let timerCleared = false;
  const { context } = boot(new Map(), async (_, { signal }) => {
    requestSignal = signal;
    stream = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      }
    });
    return new Response(stream);
  });
  context.setTimeout = (fn, delay) => {
    assert.equal(delay, 30000);
    fireTimeout = fn;
    return 7;
  };
  context.clearTimeout = timer => { assert.equal(timer, 7); timerCleared = true; };
  addTurns(context, 6);
  const task = context.refreshConversationSummary();
  fireTimeout();
  await task;
  assert.equal(requestSignal.aborted, true);
  assert.equal(stream.locked, false);
  assert.equal(timerCleared, true);
  assert.equal(vm.runInContext('summaryTask', context), null);
  assert.deepEqual(summaryState(context), { text: '', covered: 0 });
  assert.equal(context.chatContext.length, 12);
});

test('switching conversation aborts the stream and drops a late complete response', async () => {
  let finish;
  let requestSignal;
  let timerCleared = false;
  const { context, get } = boot(new Map(), async (_, { signal }) => {
    requestSignal = signal;
    // Deliberately deliver a response after cancellation to exercise the identity guard.
    return new Promise(resolve => { finish = resolve; });
  });
  context.setTimeout = () => 9;
  context.clearTimeout = timer => { assert.equal(timer, 9); timerCleared = true; };
  addTurns(context, 6);
  const task = context.refreshConversationSummary();
  get('newConversation').onclick();
  context.appendConversationTurn('新的问题', '新的回复');
  assert.equal(requestSignal.aborted, true);
  finish(sse('不能写入新对话的旧摘要'));
  await task;
  assert.equal(timerCleared, true);
  assert.deepEqual(summaryState(context), { text: '', covered: 0 });
  assert.equal(context.chatContext[0].content, '新的问题');
});

for (const [name, user, assistant, followUser, followAssistant, expected, rule] of [
  [
    "assistant proposal rejected",
    "先说展板。",
    "我建议用黄色。",
    "黄色不要。",
    "好，保留蓝色。",
    "子夜提出：黄色。\n用户反馈：拒绝黄色。",
    "接受、拒绝或修正建议不改变提出者"
  ],
  [
    "user rejects their own proposal",
    "我提议用黄色。",
    "明白，暂时作为方案。",
    "我收回自己提的黄色方案。",
    "好。",
    "用户明确表达：曾提议黄色。\n用户反馈：收回该提议。",
    "只有原始对话明确表明提出者"
  ],
  [
    "unknown proposer",
    "展板确定用蓝色，周五交。",
    "黄色是未采纳的建议。",
    null,
    null,
    "已确认决定：蓝色，周五交。\n待确认信息：黄色方案未采纳，提出者不明。",
    "转述、引用和单纯提及均不能据以推断提出者"
  ],
  [
    "user accepts assistant proposal",
    "颜色还没定。",
    "我建议用深蓝色。",
    "好，就按你说的深蓝色定。",
    "收到。",
    "子夜提出：深蓝色。\n用户反馈：接受子夜建议。\n已确认决定：深蓝色。",
    "接受、拒绝或修正建议不改变提出者"
  ],
  [
    "no objection is not acceptance",
    "先聊布局。",
    "我建议用银色标题。",
    "今天食堂有什么？",
    "换个话题聊吃的。",
    "子夜提出：银色标题。\n待确认信息：用户未明确接受。",
    "用户沉默、换话题或未反对，不等于接受"
  ],
  [
    "assistant examples stay hypothetical",
    "怎么整理预算表？",
    "比如假设你有三万元预算，这只是演示。",
    null,
    null,
    "双方讨论：子夜用三万元作为假设示例，实际预算未知。",
    "不能把子夜的举例、假设、观点或转述写成用户事实或长期观点"
  ]
]) {
  test('summary attribution fixture: ' + name, async () => {
    const requests = [];
    const { context } = boot(new Map(), async (_, { body }) => {
      requests.push(JSON.parse(body));
      return sse(expected);
    });
    context.appendConversationTurn(user, assistant);
    if (followUser) context.appendConversationTurn(followUser, followAssistant);
    addTurns(context, 5);
    await context.refreshConversationSummary();
    const expectedMessages = [{ role: 'user', content: user }, { role: 'assistant', content: assistant }];
    if (followUser) expectedMessages.push({ role: 'user', content: followUser }, { role: 'assistant', content: followAssistant });
    assert.equal(requests[0].mode, 'summary');
    assert.deepEqual(requests[0].messages, expectedMessages);
    assert.ok(buildPersonaPrompt('summary').includes(rule));
    assert.deepEqual(summaryState(context), { text: expected, covered: expectedMessages.length });
  });
}

for (const [name, previous, user, assistant, expected, rule] of [
  [
    "confirmed change supersedes previous decision",
    "已确认决定：周五交稿。",
    "最终改成周一交，周五的安排作废。",
    "明白。",
    "已确认决定：周一交稿。此前周五已作废。",
    "只保留最新明确确认的决定为当前决定"
  ],
  [
    "rejected proposal stays rejected",
    "子夜提出：黄色。\n用户反馈：拒绝黄色。",
    "给我看一下蓝色的版式。",
    "可以先看蓝色。",
    "子夜提出：黄色。\n用户反馈：黄色仍未采纳。",
    "不把拒绝或未采纳改成采纳"
  ],
  [
    "merge preserves established proposer",
    "子夜提出：蓝色。\n待确认信息：黄色提出者不明。",
    "蓝色就用你之前提的那一版。",
    "好。",
    "子夜提出：蓝色。\n已确认决定：用户接受蓝色。\n待确认信息：黄色提出者不明。",
    "不改提出者，不把来源不明升级为用户事实"
  ],
  [
    "legacy plain text summary remains readable during merge",
    "曾提过黄色方案，但没写是谁提出。",
    "交付日期确定是周五。",
    "记下了。",
    "待确认信息：黄色提出者不明。\n已确认决定：周五交付。",
    "即使作为 user 消息传入，也不是用户的新发言"
  ]
]) {
  test('summary merge fixture: ' + name, async () => {
    let request;
    const old = previous;
    const storage = new Map([
      [saveKey, 'true'],
      [chatKey, JSON.stringify({
        messages: [{ role: 'user', content: '旧轮输入' }, { role: 'assistant', content: '旧轮回复' }],
        summary: { text: old, covered: 2 }
      })]
    ]);
    const { context, get } = boot(storage, async (_, { body }) => {
      request = JSON.parse(body);
      return sse(expected);
    });
    await get('resumeConversation').onclick();
    assert.equal(summaryState(context).text, old);
    context.appendConversationTurn(user, assistant);
    context.appendConversationTurn('接着聊。', '继续。');
    addTurns(context, 5);
    await context.refreshConversationSummary();
    assert.equal(request.mode, 'summary');
    assert.deepEqual(request.messages, [
      { role: 'user', content: '【旧摘要】\n' + old },
      { role: 'user', content: user }, { role: 'assistant', content: assistant },
      { role: 'user', content: '接着聊。' }, { role: 'assistant', content: '继续。' }
    ]);
    assert.ok(buildPersonaPrompt('summary').includes(rule));
    const committed = { text: expected, covered: 6 };
    assert.deepEqual(summaryState(context), committed);
    assert.deepEqual(snapshot(storage).summary, committed);
  });
}

test('summary length boundary accepts 1200 characters but never replaces valid state with 1201', async () => {
  for (const length of [1200, 1201]) {
    const { context } = boot(new Map(), async () => sse('字'.repeat(length)));
    addTurns(context, 8);
    vm.runInContext("conversationSummary = { text: '已有摘要', covered: 2 }", context);
    await context.refreshConversationSummary();
    assert.deepEqual(summaryState(context), length === 1200
      ? { text: '字'.repeat(1200), covered: 6 }
      : { text: '已有摘要', covered: 2 });
  }
});

test('failed attribution summary preserves prior summary, raw turns and saved history', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const { context } = boot(storage, async () => sse('半段结果', ''));
  addTurns(context, 8);
  vm.runInContext("conversationSummary = { text: '子夜提出：蓝色。', covered: 2 }", context);
  await context.saveConversation();
  const before = snapshot(storage);
  const history = JSON.stringify(context.chatContext);
  await context.refreshConversationSummary();
  assert.deepEqual(snapshot(storage), before);
  assert.equal(JSON.stringify(context.chatContext), history);
  assert.deepEqual(summaryState(context), { text: '子夜提出：蓝色。', covered: 2 });
});


test('two tabs interleave new conversations without overwriting either session', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const first = boot(storage);
  const second = boot(storage);
  first.context.appendConversationTurn('A one', 'A reply');
  second.context.appendConversationTurn('B one', 'B reply');
  await Promise.all([first.context.saveConversation(), second.context.saveConversation()]);
  first.context.appendConversationTurn('A two', 'A reply 2');
  await first.context.saveConversation();
  const sessions = snapshotEntries(storage).map(([, record]) => record);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(record => record.messages.filter(m => m.role === 'user').map(m => m.content)), [
    ['A one', 'A two'], ['B one']
  ]);
  const reopened = boot(storage);
  await reopened.ready();
  reopened.get('savedConversations').value = sessions[1].sessionId;
  await reopened.get('resumeConversation').onclick();
  assert.deepEqual(reopened.visible, ['B one', 'B reply']);
});

test('two tabs resuming the same revision keep the losing tab draft and allow explicit save as new', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const seed = boot(storage);
  seed.context.appendConversationTurn('shared', 'initial');
  await seed.context.saveConversation();
  const a = boot(storage);
  const b = boot(storage);
  await Promise.all([a.get('resumeConversation').onclick(), b.get('resumeConversation').onclick()]);
  const original = snapshot(storage);
  a.context.appendConversationTurn('A', 'A reply');
  b.context.appendConversationTurn('B', 'B reply');
  assert.deepEqual(await Promise.all([a.context.saveConversation(), b.context.saveConversation()]), [true, false]);
  assert.equal(snapshot(storage).revision, original.revision + 1);
  assert.equal(snapshot(storage).messages.at(-2).content, 'A');
  assert.equal(b.context.chatContext.at(-2).content, 'B');
  assert.match(b.get('conversationSaveStatus').textContent, /另一标签页/);
  await b.get('copyConversation').onclick();
  assert.equal(snapshotEntries(storage).length, 2);
  assert.equal(snapshot(storage).messages.at(-2).content, 'B');
});

test('delete-all fences queued writes and unsaved pages from the previous epoch', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const old = boot(storage);
  const deleting = boot(storage);
  const unsaved = boot(storage);
  old.context.appendConversationTurn('will be deleted', 'reply');
  await old.context.saveConversation();
  unsaved.context.appendConversationTurn('previous epoch draft', 'reply');
  const deletion = deleting.get('deleteConversation').onclick();
  old.context.appendConversationTurn('late', 'late reply');
  const results = await Promise.all([deletion, old.context.saveConversation(), unsaved.context.saveConversation()]);
  assert.deepEqual(results.slice(1), [false, false]);
  assert.equal(snapshotEntries(storage).length, 0);
  assert.equal(old.context.chatContext.at(-2).content, 'late');
  assert.equal(boot(storage).get('resumeConversation').disabled, true);
});

test('deleting a selected session rejects its old writer and preserves unrelated sessions', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const a = boot(storage);
  const b = boot(storage);
  a.context.appendConversationTurn('delete me', 'reply');
  b.context.appendConversationTurn('keep me', 'reply');
  await Promise.all([a.context.saveConversation(), b.context.saveConversation()]);
  const id = snapshotEntries(storage).find(([, record]) => record.messages[0].content === 'delete me')[1].sessionId;
  const tab = boot(storage);
  tab.get('savedConversations').value = id;
  await tab.get('deleteSavedConversation').onclick();
  a.context.appendConversationTurn('late write', 'reply');
  assert.equal(await a.context.saveConversation(), false);
  assert.deepEqual(snapshotEntries(storage).map(([, record]) => record.messages[0].content), ['keep me']);
});

function heldReply(onCancel = () => {}) {
  let producer;
  let signal;
  const stream = new ReadableStream({
    start(controller) { producer = controller; },
    cancel() { onCancel(); },
  });
  return {
    fetch: async (_, options) => {
      signal = options.signal;
      signal.addEventListener('abort', () => producer.error(signal.reason), { once: true });
      return new Response(stream);
    },
    send(text) { producer.enqueue(new TextEncoder().encode(chunk({ content: text }))); },
    disconnect() { producer.error(new Error('mock network lost')); },
    finish() {
      producer.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      producer.close();
    },
  };
}

test('stream checkpoints save the user before first text and recover partial text after refresh', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const upstream = heldReply();
  const tab = boot(storage, upstream.fetch);
  const pending = tab.context.runChatReply('persist the question', null, null, tab.node());
  await settle();
  assert.deepEqual(snapshot(storage).messages.map(m => m.content), ['persist the question', '']);
  assert.equal(snapshot(storage).messages[1].status, 'streaming');
  upstream.send('partial text');
  await settle();
  assert.equal(snapshot(storage).messages[1].content, 'partial text');
  const reloaded = boot(storage);
  await reloaded.get('resumeConversation').onclick();
  assert.deepEqual(reloaded.visible, ['persist the question', 'partial text\n回复中断']);
  assert.equal(reloaded.context.conversationMessages().length, 0);
  upstream.finish();
  await pending;
  assert.equal(snapshot(storage).messages[1].status, 'completed');
});

test('frequent deltas are throttled and pagehide flushes pending valid text', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const upstream = heldReply();
  let writes = 0;
  const tab = boot(storage, upstream.fetch, { write: key => { if (key.startsWith(sessionPrefix)) writes++; } });
  const pending = tab.context.runChatReply('question', null, null, tab.node());
  await settle();
  upstream.send('first');
  await settle();
  const checkpointWrites = writes;
  upstream.send(' second');
  upstream.send(' third');
  await settle();
  assert.equal(writes, checkpointWrites);
  assert.equal(snapshot(storage).messages[1].content, 'first');
  tab.listeners.get('pagehide')();
  await settle();
  assert.equal(snapshot(storage).messages[1].content, 'first second third');
  assert.equal(snapshot(storage).messages[1].status, 'streaming');
  upstream.finish();
  await pending;
});

test('stop preserves partial text and records a cancelled turn outside model history', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const upstream = heldReply();
  const tab = boot(storage, upstream.fetch);
  const pending = tab.context.runChatReply('question', null, null, tab.node());
  upstream.send('part before stop');
  await settle();
  tab.context.handleChatSend();
  await pending;
  assert.equal(snapshot(storage).messages[1].status, 'cancelled');
  assert.equal(snapshot(storage).messages[1].content, 'part before stop');
  assert.equal(tab.context.conversationMessages().length, 0);
  const restored = boot(storage);
  await restored.get('resumeConversation').onclick();
  assert.match(restored.visible.at(-1), /part before stop\n已停止/);
});

test('network errors, incomplete EOF and pre-answer failures remain distinguishable', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const upstream = heldReply();
  const tab = boot(storage, upstream.fetch);
  const pending = tab.context.runChatReply('network', null, null, tab.node());
  upstream.send('network partial');
  await settle();
  upstream.disconnect();
  await pending;
  tab.context.fetch = async () => sse('EOF partial', '');
  await tab.context.runChatReply('EOF', null, null, tab.node());
  tab.context.fetch = async () => { throw new Error('mock offline'); };
  await tab.context.runChatReply('offline', null, null, tab.node());
  assert.deepEqual(snapshot(storage).messages.filter(m => m.role === 'assistant').map(m => [m.status, m.content]), [
    ['interrupted', 'network partial'], ['interrupted', 'EOF partial'], ['failed', '']
  ]);
});

test('quota failures keep the previous snapshot and a later save can retry', async () => {
  const storage = new Map([[saveKey, 'true']]);
  let fail = false;
  const tab = boot(storage, undefined, { write(key) {
    if (fail && key.startsWith(sessionPrefix)) throw new DOMException('mock quota', 'QuotaExceededError');
  } });
  tab.context.appendConversationTurn('first', 'saved');
  assert.equal(await tab.context.saveConversation(), true);
  const before = snapshotEntries(storage);
  fail = true;
  tab.context.appendConversationTurn('second', 'only on this page');
  assert.equal(await tab.context.saveConversation(), false);
  assert.deepEqual(snapshotEntries(storage), before);
  assert.match(tab.get('conversationSaveStatus').textContent, /未保存.*存储空间不足/);
  assert.equal(tab.get('retryConversationSave').hidden, false);
  assert.equal(tab.context.chatContext.at(-1).content, 'only on this page');
  fail = false;
  assert.equal(await tab.get('retryConversationSave').onclick(), true);
  assert.equal(snapshot(storage).messages.at(-1).content, 'only on this page');
  assert.equal(tab.get('retryConversationSave').hidden, true);
});

test('a failed settings or delete commit preserves the authoritative preference and saved record', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const tab = boot(storage, undefined, { write(key) {
    if (key === controlKey) throw new DOMException('mock quota', 'QuotaExceededError');
  } });
  tab.context.appendConversationTurn('keep', 'saved');
  await tab.context.saveConversation();
  const before = snapshotEntries(storage);
  tab.get('saveConversation').checked = false;
  await tab.get('saveConversation').onchange();
  assert.equal(tab.get('saveConversation').checked, true);
  await tab.get('deleteConversation').onclick();
  assert.deepEqual(snapshotEntries(storage), before);
  assert.equal(tab.context.chatContext[0].content, 'keep');
  assert.match(tab.get('conversationSaveStatus').textContent, /无法删除/);
});

test('archive and latest summary survive overlapping checkpoint writes without dropping raw turns', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const upstream = heldReply();
  const tab = boot(storage, upstream.fetch);
  addTurns(tab.context, 45);
  let resolveSummary;
  const realStream = tab.context.streamChatMessages;
  tab.context.streamChatMessages = (...args) => args[5].mode === 'summary'
    ? new Promise(resolve => { resolveSummary = resolve; }) : realStream(...args);
  const summary = tab.context.refreshConversationSummary();
  const reply = tab.context.runChatReply('new pending', null, null, tab.node());
  upstream.send('some text');
  await settle();
  resolveSummary('latest summary');
  await summary;
  assert.equal(snapshot(storage).messages.length, 92);
  assert.equal(snapshot(storage).messages[0].content, '问题 0');
  assert.equal(snapshot(storage).summary.text, 'latest summary');
  assert.equal(snapshot(storage).messages.at(-1).content, 'some text');
  tab.context.streamChatMessages = (...args) => args[5].mode === 'summary' ? Promise.resolve('latest summary') : realStream(...args);
  upstream.finish();
  await reply;
  const restored = boot(storage);
  await restored.get('resumeConversation').onclick();
  assert.equal(restored.visible[0], '问题 0');
  assert.equal(restored.visible.at(-1), 'some text');
  assert.equal(summaryState(restored.context).text, 'latest summary');
  await settle();
});

test('migration is locked, preserves IDs and ignores a legacy key rewritten by an old version', async () => {
  const id = randomUUID();
  const user = { role: 'user', content: 'legacy question', id: randomUUID() };
  const assistant = { role: 'assistant', content: 'legacy reply', id: randomUUID() };
  const storage = new Map([[saveKey, 'true'], [chatKey, JSON.stringify({ sessionId: id, messages: [user, assistant] })]]);
  const a = boot(storage);
  const b = boot(storage);
  await Promise.all([a.ready(), b.ready()]);
  assert.equal(storage.has(chatKey), false);
  assert.equal(snapshotEntries(storage).length, 1);
  assert.deepEqual(snapshot(storage, id).messages, [user, assistant]);
  storage.set(chatKey, JSON.stringify([{ role: 'user', content: 'stale legacy write' }]));
  await a.get('resumeConversation').onclick();
  assert.deepEqual(a.visible, [user.content, assistant.content]);
  assert.equal(snapshotEntries(storage).length, 1);
});

test('corrupt saved JSON is kept while a healthy separate session can be saved', async () => {
  const storage = new Map([[saveKey, 'true'], [chatKey, '{corrupt']]);
  const tab = boot(storage);
  await tab.ready();
  assert.match(tab.get('conversationSaveStatus').textContent, /原记录已保留/);
  tab.context.appendConversationTurn('new session', 'still works');
  assert.equal(await tab.context.saveConversation(), true);
  assert.equal(storage.get(chatKey), '{corrupt');
  assert.equal(snapshot(storage).messages[0].content, 'new session');
});

test('saving off by default never writes even during deltas, pagehide or completion', async () => {
  const storage = new Map();
  const upstream = heldReply();
  let writes = 0;
  const tab = boot(storage, upstream.fetch, { write: () => writes++ });
  const pending = tab.context.runChatReply('temporary', null, null, tab.node());
  upstream.send('temporary partial');
  await settle();
  tab.listeners.get('pagehide')();
  upstream.finish();
  await pending;
  assert.equal(writes, 0);
  assert.equal(storage.size, 0);
  assert.equal(tab.context.chatContext.length, 2);
});

test('global disabling is observed in another tab and blocks its later write', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const a = boot(storage);
  const b = boot(storage);
  a.context.appendConversationTurn('first', 'reply');
  await a.context.saveConversation();
  b.get('saveConversation').checked = false;
  await b.get('saveConversation').onchange();
  a.listeners.get('storage')({ key: controlKey });
  assert.equal(a.get('saveConversation').checked, false);
  a.context.appendConversationTurn('still temporary', 'reply');
  assert.equal(await a.context.saveConversation(), false);
  assert.equal(snapshotEntries(storage).length, 0);
});

test('application size limit keeps the previous snapshot without pruning the archive', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const tab = boot(storage);
  tab.context.appendConversationTurn('first', 'reply');
  await tab.context.saveConversation();
  const before = snapshot(storage);
  tab.context.appendConversationTurn('large archive', 'x'.repeat(262144));
  assert.equal(await tab.context.saveConversation(), false);
  assert.deepEqual(snapshot(storage), before);
  assert.equal(tab.context.chatContext.at(-1).content.length, 262144);
  assert.match(tab.get('conversationSaveStatus').textContent, /上限/);
});

test('browsers without Web Locks can restore but fail closed on writes', async () => {
  const storage = new Map([[saveKey, 'true'], [chatKey, JSON.stringify([{ role: 'user', content: 'legacy' }])]]);
  const tab = boot(storage, undefined, { locks: false });
  await tab.get('resumeConversation').onclick();
  assert.deepEqual(tab.visible, ['legacy']);
  tab.context.appendConversationTurn('new', 'reply');
  assert.equal(await tab.context.saveConversation(), false);
  assert.match(tab.get('conversationSaveStatus').textContent, /不支持安全写入/);
  assert.equal(snapshotEntries(storage).length, 0);
});

test('two tabs can send and complete replies concurrently without mixing their archives', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const first = heldReply();
  const second = heldReply();
  const a = boot(storage, first.fetch);
  const b = boot(storage, second.fetch);
  const replyA = a.context.runChatReply('question A', null, null, a.node());
  const replyB = b.context.runChatReply('question B', null, null, b.node());
  first.send('first A');
  second.send('first B');
  await settle();
  assert.deepEqual(snapshotEntries(storage).map(([, record]) => record.messages.map(m => m.content)), [
    ['question A', 'first A'], ['question B', 'first B']
  ]);
  second.finish();
  await replyB;
  first.send(' second A');
  first.finish();
  await replyA;
  assert.deepEqual(snapshotEntries(storage).map(([, record]) => record.messages.map(m => m.content)), [
    ['question A', 'first A second A'], ['question B', 'first B']
  ]);
});

test('migration quota failure leaves the original conversation readable', async () => {
  const original = JSON.stringify([{ role: 'user', content: 'legacy question' }, { role: 'assistant', content: 'legacy reply' }]);
  const storage = new Map([[saveKey, 'true'], [chatKey, original]]);
  const tab = boot(storage, undefined, { write(key) {
    if (key.startsWith(sessionPrefix)) throw new DOMException('mock quota', 'QuotaExceededError');
  } });
  await tab.ready();
  assert.equal(storage.get(chatKey), original);
  assert.equal(snapshotEntries(storage).length, 0);
  assert.match(tab.get('conversationSaveStatus').textContent, /暂未迁移/);
  await tab.get('resumeConversation').onclick();
  assert.deepEqual(tab.visible, ['legacy question', 'legacy reply']);
});


function restoreBrowserFixture(storage, sessions, epoch) {
  const backup = require('../web/js/23-backup-browser');
  const adapter = {
    get length() { return storage.size; },
    key: index => [...storage.keys()][index] ?? null,
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const data = { version: 1, chat: { enabled: true, sessions }, favorites: null, playlists: null,
    preferences: { companion: null, navigationCollapsed: null } };
  const build = () => backup.plan(adapter, data, { enabled: true, epoch }, randomUUID);
  return { build, async apply() {
    const { writes, conflicts } = build();
    assert.deepEqual(conflicts, []);
    return backup.restore({ storage: adapter, writes, operation: null });
  } };
}

test('same ID and revision restored after deletion cannot be overwritten by a stale page with delayed events', async () => {
  const epoch = randomUUID(), id = randomUUID();
  const key = sessionPrefix + epoch + '.' + id;
  const saved = { version: 2, sessionId: id, revision: 2, updatedAt: 100, messages: [
    { role: 'user', content: 'original' }, { role: 'assistant', content: 'original reply' }],
    summary: { text: '', covered: 0 } };
  const storage = new Map([[controlKey, JSON.stringify({ epoch, enabled: true, legacyHandled: true })],
    [key, JSON.stringify(saved)]]);
  const stale = boot(storage), deleting = boot(storage);
  await stale.get('resumeConversation').onclick();
  await deleting.get('deleteSavedConversation').onclick();
  assert.equal(storage.has(key), false);
  const restored = { ...saved, messages: [{ role: 'user', content: 'restored content' }] };
  await restoreBrowserFixture(storage, [restored], epoch).apply();
  stale.listeners.get('storage')({ key });
  stale.context.appendConversationTurn('stale in-memory input', 'unsaved reply');
  assert.equal(await stale.context.saveConversation(), false);
  assert.equal(JSON.parse(storage.get(key)).messages[0].content, 'restored content');
  assert.equal(stale.context.chatContext.at(-2).content, 'stale in-memory input');
  assert.equal(stale.get('copyConversation').hidden, false);
  const fresh = boot(storage);
  await fresh.get('resumeConversation').onclick();
  assert.equal(fresh.visible[0], 'restored content');
});

test('a stale deletion cannot remove a newly restored incarnation', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const seed = boot(storage);
  seed.context.appendConversationTurn('original', 'reply');
  await seed.context.saveConversation();
  const old = boot(storage), current = boot(storage);
  const { writeId, ...saved } = snapshot(storage);
  await current.get('deleteSavedConversation').onclick();
  await restoreBrowserFixture(storage, [saved], 'legacy').apply();
  const restored = snapshot(storage);
  assert.notEqual(restored.writeId, writeId);
  await old.get('deleteSavedConversation').onclick();
  assert.deepEqual(snapshot(storage), restored);
  assert.match(old.get('conversationSaveStatus').textContent, /更新或恢复/);
});

test('reimporting an identical session does not replace its local write generation', async () => {
  const storage = new Map([[saveKey, 'true']]);
  const saved = { version: 2, sessionId: randomUUID(), revision: 2, updatedAt: 100,
    messages: [{ role: 'user', content: 'restored' }], summary: { text: '', covered: 0 } };
  const imported = restoreBrowserFixture(storage, [saved], 'legacy');
  await imported.apply();
  const first = snapshot(storage);
  assert.deepEqual(imported.build(), { writes: [], conflicts: [] });
  assert.deepEqual(snapshot(storage), first);
});


function legacyFixture() {
  const sessionId = randomUUID();
  const first = [{ role: 'user', id: randomUUID(), content: 'legacy first' },
    { role: 'assistant', id: randomUUID(), content: 'legacy first reply' }];
  const later = [{ role: 'user', id: randomUUID(), content: 'legacy later' },
    { role: 'assistant', id: randomUUID(), content: 'legacy later reply' }];
  const source = messages => JSON.stringify({ sessionId, messages });
  const storage = new Map([[saveKey, 'true'], [chatKey, source(first)]]);
  const blockControl = key => { if (key === controlKey) throw new DOMException('synthetic quota', 'QuotaExceededError'); };
  return { storage, sessionId, first, later, source, blockControl };
}

test('migration marker quota failure is safely retried without duplicating message IDs', async () => {
  const { storage, sessionId, first, source, blockControl } = legacyFixture();
  await boot(storage, undefined, { write: blockControl }).ready();
  assert.equal(storage.get(chatKey), source(first));
  const copied = snapshot(storage, sessionId);
  assert.deepEqual(copied.messages, first);
  await boot(storage).ready();
  assert.equal(storage.has(chatKey), false);
  assert.equal(snapshotEntries(storage).length, 1);
  assert.deepEqual(snapshot(storage, sessionId), copied);
  const refreshed = boot(storage);
  await refreshed.get('resumeConversation').onclick();
  assert.deepEqual(refreshed.visible, first.map(message => message.content));
});

test('new turns added by an old tab after a marker failure are merged before deleting the source', async () => {
  const { storage, sessionId, first, later, source, blockControl } = legacyFixture();
  await boot(storage, undefined, { write: blockControl }).ready();
  storage.set(chatKey, source([...first, ...later]));
  await boot(storage, undefined, { write: blockControl }).ready();
  assert.equal(storage.get(chatKey), source([...first, ...later]));
  assert.deepEqual(snapshot(storage, sessionId).messages, [...first, ...later]);
  await boot(storage).ready();
  assert.equal(storage.has(chatKey), false);
  assert.equal(snapshotEntries(storage).length, 1);
  assert.deepEqual(snapshot(storage, sessionId).messages.map(message => message.id), [...first, ...later].map(message => message.id));
});

test('divergent legacy source is copied separately and retry does not duplicate it', async () => {
  const { storage, sessionId, first, later, source, blockControl } = legacyFixture();
  await boot(storage, undefined, { write: blockControl }).ready();
  storage.set(chatKey, source(later));
  await boot(storage, undefined, { write: blockControl }).ready();
  assert.equal(storage.get(chatKey), source(later));
  const copies = snapshotEntries(storage).map(([, item]) => item);
  assert.equal(copies.length, 2);
  const migrated = boot(storage);
  await migrated.ready();
  assert.equal(storage.has(chatKey), false);
  assert.equal(snapshotEntries(storage).length, 2);
  assert.deepEqual(snapshot(storage, sessionId).messages, first);
  assert.deepEqual(copies.find(item => item.sessionId !== sessionId).messages, later);
  assert.match(migrated.get('conversationSaveStatus').textContent, /另存为独立会话/);
});

test('migration preserves a source changed during the control write and retries from the newer source', async () => {
  const { storage, sessionId, first, later, source } = legacyFixture();
  let changed = false;
  const tab = boot(storage, undefined, { write(key) {
    if (key === controlKey && !changed) {
      changed = true;
      storage.set(chatKey, source([...first, ...later]));
    }
  } });
  await tab.ready();
  assert.equal(storage.get(chatKey), source([...first, ...later]));
  assert.equal(storage.has(controlKey), false);
  await boot(storage).ready();
  assert.equal(storage.has(chatKey), false);
  assert.deepEqual(snapshot(storage, sessionId).messages, [...first, ...later]);
});


test('deleting a copied session during a failed migration preserves the divergent legacy source', async () => {
  const { storage, later, source, blockControl } = legacyFixture();
  const tab = boot(storage, undefined, { write: blockControl });
  await tab.ready();
  storage.set(chatKey, source(later));
  await tab.get('deleteSavedConversation').onclick();
  assert.equal(snapshotEntries(storage).length, 0);
  assert.equal(storage.get(chatKey), source(later));
  assert.match(tab.get('conversationSaveStatus').textContent, /保留内容不同/);
});
