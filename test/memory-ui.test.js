'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../web/js/15-memory.js'), 'utf8');

function boot({ confirm = () => false, candidates = [], intercept = () => undefined } = {}) {
  const nodes = new Map();
  const requests = [];
  const documentHandlers = {};
  let panelOpen = false;
  const hostile = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  function node(tagName) {
    return {
      tagName, value: '', children: [], handlers: {},
      set innerHTML(_) { assert.fail('memory UI must never assign innerHTML'); },
      setAttribute() {}, focus() {}, reset() {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      matches(selector) { return tagName === 'memoryPanel' && selector === ':popover-open' && panelOpen; },
      addEventListener(event, handler) {
        this.handlers[event] = tagName === 'memoryPanel' && event === 'toggle' ? detail => {
          panelOpen = detail.newState === 'open';
          handler(detail);
        } : handler;
      }
    };
  }
  function get(id) {
    if (!nodes.has(id)) nodes.set(id, node(id));
    return nodes.get(id);
  }
  const context = vm.createContext({
    document: { createElement: node, getElementById: get,
      addEventListener(event, handler) { documentHandlers[event] = handler; } },
    get localStorage() { assert.fail('memory UI must never access localStorage'); },
    confirm,
    fetch: async (path, options) => {
      const request = { path, method: options.method, body: options.body && JSON.parse(options.body) };
      requests.push(request);
      const override = intercept(request);
      if (override) return override;
      return {
        ok: true, json: async () => path.endsWith('/status')
          ? { enabled: true, schemaVersion: 1 }
          : path.endsWith('/settings') ? { useInChat: JSON.parse(options.body || '{}').useInChat ?? false }
          : path.endsWith('/discovery') ? { autoExtractEnabled: false, epoch: 0 }
          : path.endsWith('/candidates') ? { items: candidates }
          : { items: [{ id: 'test-id', revision: 1, category: 'music', kind: 'manual_note', content: hostile }], total: 1 }
      };
    }
  });
  vm.runInContext(source, context);
  return { get, hostile, requests, notify: () => documentHandlers['memory-candidates-updated']() };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const candidateRead = request => request.path === '/api/memory/candidates' && request.method === 'GET';
const candidateReview = request => request.path === '/api/memory/candidates' && request.method === 'POST';
const candidate = content => ({ id: 'candidate-id', category: 'music', kind: 'user_preference',
  content, evidence: [{ quote: content }] });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('busy candidate reads merge consecutive notifications into one follow-up read', async () => {
  let resolveRead;
  const delayed = new Promise(resolve => { resolveRead = resolve; });
  let reads = 0;
  const { get, notify, requests } = boot({
    candidates: [candidate('新候选')],
    intercept: request => candidateRead(request) && ++reads === 1 ? delayed : undefined,
  });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  notify();
  notify();
  notify();
  assert.equal(requests.filter(candidateRead).length, 1);
  resolveRead(response({ items: [candidate('旧候选')] }));
  await settle();
  assert.equal(requests.filter(candidateRead).length, 2);
  assert.equal(get('memoryCandidates').children[0].children[1].textContent, '新候选');
});

for (const [button, action, edit] of [[0, 'save', false], [1, 'save', true], [2, 'reject', false]]) {
  test('notifications during candidate ' + (edit ? 'edit and save' : action) + ' use the review refresh', async () => {
    let resolveReview;
    const delayed = new Promise(resolve => { resolveReview = resolve; });
    const { get, notify, requests } = boot({
      candidates: [candidate('待确认偏好')],
      intercept: request => candidateReview(request) ? delayed : undefined,
    });
    get('memoryPanel').handlers.toggle({ newState: 'open' });
    await settle();
    get('memoryCandidates').children[0].children.at(-1).children[button].handlers.click();
    if (edit) {
      get('memoryContent').value = '修改后的偏好';
      get('memoryForm').handlers.submit({ preventDefault() {} });
    }
    notify();
    notify();
    assert.equal(requests.filter(candidateRead).length, 1);
    assert.equal(requests.find(candidateReview).body.action, action);
    if (edit) assert.equal(requests.find(candidateReview).body.fields.content, '修改后的偏好');
    resolveReview(response({}));
    await settle();
    assert.equal(requests.filter(candidateRead).length, 2);
  });
}

test('a failed review still drains the pending refresh and preserves its error message', async () => {
  let resolveReview;
  const delayed = new Promise(resolve => { resolveReview = resolve; });
  const { get, notify, requests } = boot({
    candidates: [candidate('待确认偏好')],
    intercept: request => candidateReview(request) ? delayed : undefined,
  });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  get('memoryCandidates').children[0].children.at(-1).children[0].handlers.click();
  notify();
  resolveReview(response({ error: '模拟保存失败' }, 500));
  await settle();
  assert.equal(requests.filter(candidateRead).length, 2);
  assert.equal(get('memoryError').textContent, '模拟保存失败');
  notify();
  await settle();
  assert.equal(requests.filter(candidateRead).length, 3);
});

test('a failed parallel read does not overlap the in-flight candidate read or loop', async () => {
  let resolveRead;
  const delayed = new Promise(resolve => { resolveRead = resolve; });
  let reads = 0;
  const { get, notify, requests } = boot({
    intercept: request => {
      if (request.path.endsWith('/items')) return response({ error: '模拟正式记忆读取失败' }, 500);
      if (!candidateRead(request)) return undefined;
      reads++;
      if (reads === 1) return delayed;
      if (reads === 2) return response({ error: '模拟候选刷新失败' }, 500);
      return undefined;
    },
  });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  notify();
  await settle();
  assert.equal(requests.filter(candidateRead).length, 1);
  resolveRead(response({ items: [] }));
  await settle();
  assert.equal(requests.filter(candidateRead).length, 2);
  assert.equal(get('memoryError').textContent, '模拟正式记忆读取失败');
  notify();
  await settle();
  assert.equal(requests.filter(candidateRead).length, 3);
});

test('closing the panel discards pending notifications and prevents new candidate reads', async () => {
  let resolveReview;
  const delayed = new Promise(resolve => { resolveReview = resolve; });
  const { get, notify, requests } = boot({
    candidates: [candidate('待确认偏好')],
    intercept: request => candidateReview(request) ? delayed : undefined,
  });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  get('memoryCandidates').children[0].children.at(-1).children[0].handlers.click();
  notify();
  get('memoryPanel').handlers.toggle({ newState: 'closed' });
  notify();
  resolveReview(response({}));
  await settle();
  assert.equal(requests.filter(candidateRead).length, 1);
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  assert.equal(requests.filter(candidateRead).length, 2);
});

test('memory UI renders hostile content as literal text with no browser storage access', async () => {
  const { get, hostile, requests } = boot();
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  const paragraph = get('memoryList').children[0].children[1];
  assert.equal(paragraph.tagName, 'p');
  assert.equal(paragraph.textContent, hostile);
  assert.deepEqual(paragraph.children, []);
  assert.deepEqual(requests.map(request => request.path), ['/api/memory/status', '/api/memory/settings', '/api/memory/discovery', '/api/memory/items', '/api/memory/candidates']);
});

test('memory UI only sends clear after explicit confirmation and only to its API', async () => {
  let accepted = false;
  const { get, requests } = boot({ confirm: () => accepted });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  get('clearMemories').handlers.click();
  await settle();
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 0);
  accepted = true;
  get('clearMemories').handlers.click();
  await settle();
  assert.deepEqual(requests.find(request => request.method === 'DELETE'), {
    path: '/api/memory/items', method: 'DELETE', body: { confirm: true }
  });
});

test('candidate text, evidence and reason render literally and saving requires a click', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { get, requests } = boot({ candidates: [{
    id: 'candidate-id', category: 'preference', kind: 'user_preference', createdAt: '2026-11-10',
    content: hostile, evidence: [{ quote: hostile }], reason: hostile,
  }] });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  const [, content, quote, reason, actions] = get('memoryCandidates').children[0].children;
  assert.equal(content.textContent, hostile);
  assert.equal(quote.textContent, '原话：' + hostile);
  assert.equal(reason.textContent, '发现理由：' + hostile);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  actions.children[0].handlers.click();
  await settle();
  assert.deepEqual(requests.find(request => request.method === 'POST').body, { id: 'candidate-id', action: 'save' });
});

test('related memory content and match reasons render as text without blocking candidate actions', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { get, requests } = boot({ candidates: [{
    id: 'candidate-id', category: 'preference', kind: 'user_preference', createdAt: '2026-11-10',
    content: '候选正文', evidence: [{ quote: '候选正文' }], reason: '长期偏好',
    relation: { type: 'possible_supplement', target: { id: 'active-id', content: hostile }, reason: hostile },
  }] });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  const [, , , , related, actions] = get('memoryCandidates').children[0].children;
  assert.match(related.children[0].textContent, /可能补充/);
  assert.equal(related.children[1].textContent, hostile);
  assert.equal(related.children[2].textContent, hostile);
  assert.deepEqual(related.children[1].children, []);
  assert.deepEqual(actions.children.map(button => button.textContent), ['保存', '编辑后保存', '暂不保存']);
  actions.children[0].handlers.click();
  await settle();
  assert.deepEqual(requests.find(request => request.method === 'POST').body, { id: 'candidate-id', action: 'save' });
});

test('pending and formal relation sources are distinct and pending markup renders as text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { get, requests } = boot({ candidates: [{
    id: 'candidate-id', category: 'goal', kind: 'user_fact', createdAt: '2026-11-10',
    content: '项目目标', evidence: [{ quote: '项目目标' }], reason: '长期信息',
    relation: {
      type: 'possible_duplicate', target: { id: 'pending-id', content: hostile, source: 'pending' }, reason: hostile,
      other: { type: 'possible_supplement', target: { id: 'active-id', content: '已有目标', source: 'active' }, reason: '共享项目' },
    },
  }] });
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  const [, , , , pending, formal, actions] = get('memoryCandidates').children[0].children;
  assert.equal(pending.children[0].textContent, '另一条待确认记忆 · 可能重复');
  assert.equal(pending.children[1].textContent, hostile);
  assert.equal(pending.children[2].textContent, hostile);
  assert.deepEqual(pending.children[1].children, []);
  assert.equal(formal.children[0].textContent, '已有正式记忆 · 可能补充');
  assert.deepEqual(actions.children.map(button => button.textContent), ['保存', '编辑后保存', '暂不保存']);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
});

test('memory UI loads consent and persists a change through its API', async () => {
  const { get, requests } = boot();
  get('memoryPanel').handlers.toggle({ newState: 'open' });
  await settle();
  const toggle = get('memoryUseInChat');
  assert.equal(toggle.checked, false);
  assert.equal(get('memoryUseStatus').textContent, '已关闭');
  toggle.checked = true;
  toggle.handlers.change();
  await settle();
  assert.equal(toggle.checked, true);
  assert.equal(get('memoryUseStatus').textContent, '已开启');
  assert.deepEqual(requests.at(-1), {
    path: '/api/memory/settings', method: 'PATCH', body: { useInChat: true }
  });
});
