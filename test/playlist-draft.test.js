'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const vm = require('node:vm');

const track = (song, artist = '测试歌手') => ({ song, artist, phase: '开场', reason: '听感安静' });
const catalog = (id, song, album) => ({ id, song, artist: '测试歌手', cover: '', album });
const draft = (tracks = [track('甲曲')], name = '夜色歌单') => ({
  action: 'playlist_draft', name, description: '从安静到抒情', scene: '深夜', mood: '平静', count: tracks.length, tracks,
});
const frame = body => '[JSON_START]' + JSON.stringify(body) + '[JSON_END]';
const settle = () => new Promise(resolve => setImmediate(resolve));
const sse = (raw, complete = true) => new Response(
  'data: ' + JSON.stringify({ choices: [{ delta: { content: raw } }] }) + '\n\n' +
  (complete ? 'data: [DONE]\n\n' : '')
);

function boot() {
  const nodes = new Map();
  const added = [];
  const played = [];
  const visible = [];
  function node() {
    return {
      children: [], textContent: '', isConnected: true, style: {},
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(name, listener) { this[name] = listener; },
      querySelector() { return this; },
      setAttribute() {},
      remove() { this.isConnected = false; },
    };
  }
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const context = vm.createContext({
    AbortController, AbortSignal, TextEncoder, TextDecoder, crypto: { randomUUID },
    document: { getElementById: element, createElement: node },
    NE_API: '/ncm', CHAT_API: '/api/chat', companionMode: 'chat',
    companionPreferences: { length: 'short' }, chatContext: [], chatInput: { value: '', focus() {} },
    chatMsgs: node(), localStorage: { getItem: () => null },
    playbackQueue: {
      addMany(tracks) { added.push(...tracks); return tracks.length; },
      async playTracks(tracks) { played.push(...tracks); return true; },
      message: '已进入队列',
    },
    addQueueTrack(track) { added.push(track); },
    queueButton(text, click) { return { textContent: text, click, disabled: false }; },
  });
  for (const file of ['00-storage-coordination.js', '00-credentials.js', '09-chat.js', '12-conversation.js', '17-music-companion.js', '19-playlist-draft.js']) {
    vm.runInContext(readFileSync(join(__dirname, '../web/js', file), 'utf8'), context);
  }
  context.setAIMessageText = (el, text) => { el.textContent = text; visible.push(text); };
  context.addUMsg = () => {};
  context.addAIMsg = node;
  context.musicPlayerContext = () => null;
  return { context, node, added, played, visible, element };
}

test('playlist scene routing keeps ordinary chat, single recommendations and player controls separate', () => {
  const { context: c } = boot();
  assert.equal(c.musicRequest('今晚有点累，帮我安排一个适合独处的歌单').type, 'playlist_draft');
  const staged = c.musicRequest('今晚想听一些安静的华语歌曲，前面舒缓一点，后面逐渐有情绪，安排 8 首。');
  assert.equal(staged.type, 'playlist_draft');
  assert.equal(staged.count, 8);
  assert.equal(c.musicRequest('我不想生成歌单'), null);
  assert.equal(c.musicRequest('推荐一首安静的歌').type, 'recommend');
  assert.equal(c.musicRequest('放一首《演员》').type, 'play');
  assert.equal(c.musicRequest('暂停一下').type, 'pause');
  assert.equal(c.musicRequest('我喜欢这份歌单'), null);
  assert.equal(c.musicRequest('不要生成歌单'), null);
  assert.equal(c.musicRequest('播放这份歌单').type, 'discuss');
});

test('playlist count supports Arabic and Chinese, defaults to six and caps at twelve', () => {
  const { context: c } = boot();
  for (const [input, count] of [
    ['安排一个深夜歌单', 6], ['做一个安静歌单，安排 8 首', 8],
    ['生成一个十首歌的歌单', 10], ['生成歌单十二首', 12],
    ['安排 23 首作为歌单', 12], ['给我 １ 首的歌单', 1],
  ]) assert.equal(c.playlistRequest(input).count, count, input);
  assert.equal(c.playlistRequest('生成歌单，同一首可以重复两次').repeat, true);
  assert.equal(c.playlistRequest('生成歌单，不要重复播放').repeat, false);
});

test('strict playlist schema checks count, metadata, song fields and structured boundaries', () => {
  const { context: c } = boot();
  assert.equal(c.parsePlaylistDraft(frame(draft()), 1).tracks.length, 1);
  for (const value of [
    { ...draft(), count: 13 }, { ...draft(), count: 2 }, { ...draft(), mood: '' },
    draft([{ song: '甲曲', artist: '歌手', phase: '开场' }]),
    draft([{ ...track('甲曲'), id: '123', url: 'https://invalid.example' }]),
  ]) assert.equal(c.parsePlaylistDraft(frame(value), 1), null);
  assert.equal(c.parsePlaylistDraft(frame(draft()), 2), null);
  assert.equal(c.parsePlaylistDraft('[JSON_START]{broken[JSON_END]', 1), null);
  assert.equal(c.parsePlaylistDraft(frame(draft()) + '多余指令', 1), null);
});

test('catalog verifies exact credits, distinguishes covers and preserves same-artist versions', async () => {
  const { context: c } = boot();
  c.fetch = async url => {
    assert.match(url, /^\/ncm\/cloudsearch\?/);
    return Response.json({ result: { songs: [
      { id: 1, name: '甲曲', ar: [{ name: '测试歌手' }], al: { name: '原专辑', picUrl: 'https://example.test/cover.png' } },
      { id: 2, name: '甲曲', ar: [{ name: '同名歌手' }] },
      { id: 3, name: '甲曲（翻唱）', ar: [{ name: '测试歌手' }] },
      { id: 4, name: '甲曲', ar: [{ name: '测试歌手' }], al: { name: '重录专辑' } },
    ] } });
  };
  const result = await c.verifyPlaylistDraft(draft(), { repeat: false }, undefined, c.verifyMusicTrack, new Map());
  assert.equal(result.entries[0].status, 'ambiguous');
  assert.deepEqual(Array.from(result.entries[0].options, option => option.id), ['1', '4']);
  assert.equal(result.entries[0].options[0].cover, 'https://example.test/cover.png');
  assert.equal(result.entries[0].track, null);
});

test('bounded verification retains order, separates misses and errors, and reuses duplicate searches', async () => {
  const { context: c } = boot();
  let active = 0, max = 0, calls = 0;
  const cache = new Map();
  const lookup = async song => {
    calls++;
    active++;
    max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, song === '甲曲' ? 15 : 1));
    active--;
    if (song === '超时') throw new Error('timeout');
    if (song === '未找到') return [];
    return [catalog(song === '甲曲' ? '11' : '12', song)];
  };
  const source = draft([track('甲曲'), track('未找到'), track('乙曲'), track('超时'), track('甲曲')]);
  const result = await c.verifyPlaylistDraft(source, { repeat: false }, undefined, lookup, cache);
  assert.deepEqual(Array.from(c.playlistRows(result), entry => entry.status), ['verified', 'missing', 'verified', 'unavailable', 'duplicate']);
  assert.deepEqual(Array.from(result.entries, entry => entry.suggestion.song), ['甲曲', '未找到', '乙曲', '超时', '甲曲']);
  assert.equal(max, 3);
  assert.equal(calls, 4);
  const repeat = await c.verifyPlaylistDraft(source, { repeat: true }, undefined, lookup, cache);
  assert.equal(c.playlistRows(repeat)[4].status, 'verified');
  assert.equal(calls, 6);
});

test('draft preview does not write the queue or play until the corresponding button is used', async () => {
  const { context: c, node, added, played } = boot();
  const result = await c.verifyPlaylistDraft(draft([track('甲曲'), track('乙曲')]), { repeat: false }, undefined,
    async song => [catalog(song === '甲曲' ? '11' : '12', song)], new Map());
  const container = node();
  c.renderPlaylistPreview(container, result, '给我一个两首歌的歌单');
  assert.deepEqual(added, []);
  assert.deepEqual(played, []);
  const card = container.children[0];
  const [first] = card.children[3].children;
  first.children.at(-1).children[0].click();
  assert.deepEqual(added.map(entry => entry.id), ['11']);
  const [addAll, play] = card.children[4].children;
  addAll.click();
  assert.deepEqual(added.map(entry => entry.id), ['11', '11', '12']);
  assert.deepEqual(played, []);
  await play.click();
  assert.deepEqual(played.map(entry => entry.id), ['11', '12']);
});

test('SSE interruption, empty response and malformed JSON never verify or render a draft', async () => {
  const { context: c, node, visible } = boot();
  let searches = 0;
  for (const response of [sse(frame(draft()), false), sse(''), sse('[JSON_START]{broken[JSON_END]')]) {
    c.fetch = async url => {
      if (url !== '/api/chat') searches++;
      return response;
    };
    const container = node();
    await c.runChatReply('生成一个一首的歌单', { type: 'playlist_draft', count: 1 }, null, container);
    assert.ok(!container.children.some(child => child.className === 'playlist-preview'));
  }
  assert.equal(searches, 0);
  assert.match(visible.join('\n'), /没有完整结束/);
  assert.match(visible.join('\n'), /格式或首数/);
});

test('switching conversations aborts playlist verification and prevents late rendering', async () => {
  const { context: c, node, element } = boot();
  let resolveSearch, seenSignal;
  c.fetch = async (url, options) => {
    if (url === '/api/chat') return sse(frame(draft()));
    seenSignal = options.signal;
    return new Promise(resolve => { resolveSearch = resolve; });
  };
  const old = node();
  const task = c.runChatReply('生成一首的歌单', { type: 'playlist_draft', count: 1 }, null, old);
  await settle();
  element('newConversation').onclick();
  assert.ok(seenSignal.aborted);
  resolveSearch(Response.json({ result: { songs: [] } }));
  await task;
  assert.equal(old.children.length, 0);
  assert.equal(c.chatContext.length, 0);
});

test('a new playlist request supersedes the prior response without touching the new preview', async () => {
  const { context: c, node, added, played } = boot();
  const containers = [];
  c.addAIMsg = () => { const el = node(); containers.push(el); return el; };
  let release;
  let count = 0;
  c.fetch = async url => {
    if (url === '/api/privacy/check') return new Response(null, { status: 204 });
    if (url !== '/api/chat') return Response.json({ result: { songs: [] } });
    if (++count === 1) return new Promise(resolve => { release = resolve; });
    return sse(frame(draft([track('乙曲')], '新歌单')));
  };
  const old = c.sendMessage(false, '安排 1 首做成旧歌单');
  await settle();
  await c.sendMessage(false, '安排 1 首做成新歌单');
  release(sse(frame(draft([track('甲曲')], '旧歌单'))));
  await old;
  assert.equal(containers[0].children.length, 0);
  assert.equal(containers[1].children[0].children[0].textContent, '新歌单');
  assert.deepEqual(added, []);
  assert.deepEqual(played, []);
});
