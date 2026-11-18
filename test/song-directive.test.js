const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

test('AI song directive preserves spaces in the title and artist', async () => {
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: () => ({ addEventListener() {} }) },
    escHTML: value => value,
    resolveTagToKeyword: value => value,
    playOnlineMusic: (...args) => calls.push(args)
  });
  for (const file of ['00-credentials.js', '09-chat.js', '04-player.js']) {
    vm.runInContext(readFileSync(join(__dirname, '../web/js', file), 'utf8'), context);
  }
  context.playOnlineMusic = (...args) => calls.push(args);
  context.addAIMsg = () => {};
  await vm.runInContext(
    'execTagSwitch(parseSongDirective(\'Guide [JSON_START]{"song":"No Surprises","artist":"The Radio Band"}[JSON_END]\').tag)',
    context
  );
  assert.deepEqual(calls, [['No Surprises', 'The Radio Band', true]]);
});

test('chat only triggers music for explicit requests', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(__dirname, '../web/js/00-credentials.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../web/js/09-chat.js'), 'utf8'), context);
  for (const [message, expected] of [
    ['今天好累', false],
    ['想听你说说', false],
    ['不要放歌', false],
    ['放一首薛之谦', true],
    ['我现在想听薛之谦的歌曲', true],
    ['我想听周深的歌', true],
    ['怎么不播放迟迟', true],
    ['我现在不想听薛之谦的歌曲', false],
    ['我想听听你怎么看', false],
    ['今天好累，放一首安静的歌', true]
  ]) assert.equal(context.wantsMusic(message), expected, message);
  assert.equal(context.wantsMusic('放啊', '这次来一首《迟迟》。'), true);
  assert.equal(context.wantsMusic('那就播这首吧', '这次来一首《迟迟》。'), true);
  assert.equal(context.wantsMusic('放啊', '我刚喝了杯水。'), false);
});

test('chat routes current topics and explicit lookups to web search', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(__dirname, '../web/js/00-credentials.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../web/js/09-chat.js'), 'utf8'), context);
  for (const [message, expected] of [
    ['你有了解最近的综艺《后悔友期》吗', true],
    ['帮我查一下这个节目', true],
    ['这部电影什么时候上映？', true],
    ['今天好累，陪我说说话', false],
    ['最近工作怎么样', false],
    ['不用搜索，聊聊今天的新闻', false]
  ]) assert.equal(context.needsWebSearch(message), expected, message);
});

test('factual follow-ups can search after a grounded turn', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(__dirname, '../web/js/00-credentials.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../web/js/09-chat.js'), 'utf8'), context);
  assert.equal(context.needsWebSearch('那她是哪一期来的？', true), true);
  assert.equal(context.needsWebSearch('那她是哪一期来的？', false), false);
  assert.equal(context.needsWebSearch('你怎么看她那段表现？', true), false);
});

test('front end sends conversation data and mode without a system message', async () => {
  const requests = [];
  const encoder = new TextEncoder();
  const context = vm.createContext({
    TextDecoder,
    TextEncoder,
    CHAT_API: '/api/chat',
    companionMode: 'light',
    companionPreferences: { length: 'long', suggestMusic: true },
    conversationSummary: { text: '用户提到蓝鲸海报。' },
    conversationMessages: () => [{ role: 'assistant', content: '后来改了几版？' }],
    getRecentPlayedList: () => '绅士',
    fetch: async (url, options) => {
      assert.equal(url, '/api/chat');
      requests.push(JSON.parse(options.body));
      const response = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"知'));
          controller.enqueue(encoder.encode('道了"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(response, { headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  vm.runInContext(readFileSync(join(__dirname, '../web/js/00-credentials.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../web/js/09-chat.js'), 'utf8'), context);
  const deltas = [];
  assert.equal(await context.callAIStream('改了三版', value => deltas.push(value)), '知道了');
  assert.deepEqual(deltas, ['知道了']);
  assert.equal(requests[0].mode, 'light');
  assert.equal(requests[0].summary, '用户提到蓝鲸海报。');
  assert.deepEqual(requests[0].messages, [
    { role: 'assistant', content: '后来改了几版？' },
    { role: 'user', content: '改了三版' }
  ]);
  assert.equal(requests[0].replyLength, 'long');
  assert.equal(requests[0].suggestMusic, true);
  await context.callAIStream('放一首歌', null, true);
  assert.equal(requests[1].mode, 'music');
  assert.equal(requests[1].recentPlayed, '绅士');
  assert.ok(requests[1].messages.every(message => message.role !== 'system'));
});