'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const frame = data => '在这里。\n[JSON_START]' + JSON.stringify(data) + '[JSON_END]';
const actor = { id: 21, name: '演员', ar: [{ name: '薛之谦' }] };
const cover = { id: 22, name: '演员', ar: [{ name: '另一位歌手' }] };
function boot(songs = [actor]) {
  const calls = [];
  const labels = [];
  const context = vm.createContext({
    AbortController, AbortSignal, TextDecoder, TextEncoder, CHAT_API: '/api/chat', NE_API: '/ncm',
    audio: { paused: true, currentTime: 15, pause() { this.paused = true; } },
    currentSong: null, loadingSong: false, recommendingNext: false, playHistory: [], favSongs: [],
    chatContext: [], companionMode: 'chat', conversationSummary: { text: '' },
    companionPreferences: { length: 'short' }, conversationMessages: () => [],
    getRecentPlayedList: () => '', document: { getElementById: () => ({}), createElement: () => ({}) },
    saveConversation() {}, flushConversationCheckpoint() {}, checkpointConversation() {}, refreshConversationSummary() {},
    conversationReplyText: (message, note) => [message.content, note || '回复中断'].filter(Boolean).join('\n'),
    setAIMessageText(_, text) { labels.push(text); },
    fetch: async url => {
      calls.push(url);
      return Response.json({ result: { songs } });
    },
    execTagSwitch: async track => { calls.push(['play', track.id]); return true; },
    beginConversationTurn(user) { return [{ role: 'user', content: user }, { role: 'assistant', content: '', status: 'streaming' }]; },
    finishConversationTurn(turn, status) {
      if (status === 'completed') context.chatContext.push(...turn);
      turn[1].status = status;
    },
  });
  for (const name of ['00-credentials.js', '09-chat.js', '17-music-companion.js']) vm.runInContext(
    readFileSync(join(__dirname, '../web/js', name), 'utf8'), context);
  context.setAIMessageText = (_, text) => labels.push(text);
  return { context, calls, labels };
}

test('intent separates discussion, mood recommendations, playback consent and player controls', () => {
  const { context: c } = boot();
  assert.equal(c.musicRequest('今天真累，想听你说说'), null);
  assert.equal(c.musicRequest('我想听你说说'), null);
  assert.equal(c.musicRequest('我在写推荐信，可以帮我看看吗'), null);
  assert.equal(c.musicRequest('这首歌为什么这么有感觉？').type, 'discuss');
  assert.equal(c.musicRequest('听歌能提高注意力吗？').type, 'discuss');
  for (const value of ['最近有点烦，推荐一些安静的歌。', '想听一些有故事感的歌曲。', '今天心情不错，想听轻快一点的。', '我想听周杰伦', '有没有类似《演员》的歌曲？']) {
    assert.equal(c.musicRequest(value).type, 'recommend', value);
  }
  assert.equal(c.musicRequest('放一首《演员》').title, '演员');
  assert.equal(c.musicRequest('来首歌', '', true).type, 'play');
  assert.equal(c.musicRequest('放一首薛之谦的《演员》').artist, '薛之谦');
  assert.equal(c.musicRequest('放第一首', '《演员》').selection, 1);
  for (const [text, action] of Object.entries({ 暂停一下: 'pause', 继续播放: 'resume', 下一首: 'next',
    上一首: 'previous', 把这首歌收藏起来: 'favorite', 再放一遍: 'replay', 换一首类似的: 'similar' })) {
    assert.equal(c.musicRequest(text).type, action);
  }
});

test('a named next-song request verifies and queues the track without a model call or immediate playback', async () => {
  const { context: c, calls, labels } = boot([
    { id: 25, name: '彩券', ar: [{ name: '薛之谦' }] }
  ]);
  const scheduled = [];
  c.currentSong = { id: '21', name: '当前歌曲', artist: '歌手' };
  c.audio.paused = false;
  c.playbackQueue = { insertNext: (track, followCurrent) => scheduled.push([track.id, followCurrent]) > 0 };
  c.callAIStream = async () => { throw new Error('A named queue request should not call the model'); };
  const text = '下一首歌播放薛之谦的彩券';
  const intent = c.musicRequest(text);
  assert.equal(intent.type, 'queue_next');
  assert.equal(intent.title, '彩券');
  assert.equal(intent.artist, '薛之谦');
  assert.equal(c.musicRequest('下一首').type, 'next');
  assert.equal(c.musicRequest('等这首播完，再播放《彩券》').type, 'queue_next');
  await c.runChatReply(text, intent, null, { isConnected: true });
  assert.deepEqual(scheduled, [['25', true]]);
  assert.equal(calls.some(Array.isArray), false);
  assert.equal(c.currentSong.id, '21');
  assert.match(labels.at(-1), /已安排下一首：.*彩券.*当前歌曲播完后/u);
});

test('player controls send current state and recommendations add only a few tracks', () => {
  const { context: c } = boot();
  c.currentSong = { name: '演员', artist: '薛之谦', url: 'private-audio-url' };
  c.playHistory = Array.from({ length: 7 }, () => c.currentSong);
  c.favSongs = c.playHistory;
  const control = c.musicPlayerContext('pause');
  assert.equal(control.current.song, '演员');
  assert.equal(control.current.url, undefined);
  assert.equal(control.recent, undefined);
  assert.equal(control.favorites, undefined);
  const recommend = c.musicPlayerContext('recommend');
  assert.equal(recommend.recent.length, 3);
  assert.equal(recommend.favorites.length, 3);
});

test('recommendations are catalog-verified and only play after a fresh explicit selection', async () => {
  const { context: c, calls } = boot();
  const reply = await c.applyMusicReply(frame({ action: 'recommend', tracks: [
    { song: '演员', artist: '薛之谦', reason: '旋律收得很轻。' },
    { song: '虚构标题', artist: '虚构歌手', reason: '待核验。' },
  ] }), { type: 'recommend' });
  assert.match(reply, /演员.*薛之谦/);
  assert.doesNotMatch(reply, /虚构/);
  assert.ok(!calls.some(Array.isArray));
  const last = { role: 'assistant', content: reply };
  c.chatContext.push(last);
  c.bindMusicRecommendation(last);
  await c.applyMusicReply(frame({ action: 'play', song: '演员', artist: '薛之谦' }), { type: 'play', confirmation: true, selection: 1 });
  assert.deepEqual(calls.filter(Array.isArray), [['play', '21']]);
  c.chatContext.push({ role: 'assistant', content: '现在换个话题' });
  assert.match(await c.applyMusicReply(frame({ action: 'play', song: '演员', artist: '薛之谦' }),
    { type: 'play', confirmation: true, selection: 1 }), /没有可用/);
  assert.equal(calls.filter(Array.isArray).length, 1);
});

test('a failed catalog lookup does not discard another verified recommendation', async () => {
  const { context: c } = boot();
  c.fetch = async url => url.includes(encodeURIComponent('演员')) ? Response.json({ result: { songs: [actor] } })
    : new Response('unavailable', { status: 503 });
  const reply = await c.applyMusicReply(frame({ action: 'recommend', tracks: [
    { song: '演员', artist: '薛之谦', reason: '节奏平缓。' },
    { song: '未验证的歌曲', artist: '歌手', reason: '柔和。' },
  ] }), { type: 'recommend' });
  assert.match(reply, /演员/);
  assert.doesNotMatch(reply, /未验证的歌曲/);
});

test('explicit title does not pick an arbitrary same-title singer or substitute a different title', async () => {
  const { context: c, calls } = boot([actor, cover]);
  const raw = frame({ song: '演员', artist: '薛之谦' });
  assert.match(await c.applyMusicReply(raw, { type: 'play', title: '演员' }), /同名版本/);
  assert.match(await c.applyMusicReply(raw, { type: 'play', title: '晴天' }), /歌名.*不同/);
  assert.ok(!calls.some(Array.isArray));
  const directiveOnly = raw.slice(raw.indexOf('[JSON_START]'));
  assert.match(await c.applyMusicReply(directiveOnly, { type: 'play', title: '演员', artist: '薛之谦' }), /正在播放/);
  assert.deepEqual(calls.filter(Array.isArray), [['play', '21']]);
});

test('streamed song introduction stays visible through verification, playback and conversation completion', async () => {
  const { context: c, calls, labels } = boot();
  const introduction = '这首歌用克制的旋律讲了一段关系。';
  const directive = '[JSON_START]{"action":"play","song":"演员","artist":"薛之谦"}[JSON_END]';
  const prose = introduction + '\n\n放一下这首。';
  c.callAIStream = async (_, delta, __, ___, complete) => {
    delta(prose);
    complete();
    return prose + '\n' + directive;
  };

  await c.runChatReply('播放薛之谦的《演员》', { type: 'play', title: '演员', artist: '薛之谦' }, null,
    { isConnected: true });
  assert.deepEqual(calls.filter(Array.isArray), [['play', '21']]);
  assert.ok(labels.includes(introduction));
  assert.ok(labels.every(label => !label.includes('放一下这首')));
  assert.ok(labels.includes(introduction + '\n\n正在网易云核对歌曲…'));
  assert.ok(labels.includes(introduction + '\n\n正在加载《演员》…'));
  assert.equal(labels.at(-1), introduction);
  assert.equal(c.chatContext.at(-1).content, introduction);
});

test('closing cleanup removes only a standalone playback line after music prose', () => {
  const { context: c } = boot();
  const explanation = '《演员》的编曲很克制。\n旋律留出了空间。';
  assert.equal(c.stripPlaybackClosing(explanation + '\n\n放一下这首。'), explanation);
  assert.equal(c.stripPlaybackClosing(explanation + '\n放下一首吧。'), explanation);
  assert.equal(c.stripPlaybackClosing('放一下这首。', true), '放一下这首。');
  const inline = '歌词让我想到那句「放一下这首」。';
  assert.equal(c.stripPlaybackClosing(inline, true), inline);
  const unrelated = '按照示例抄写两行。\n放一下这首。';
  assert.equal(c.stripPlaybackClosing(unrelated), unrelated);
});

test('playback failure and different catalog versions do not present an introduction as confirmed', async () => {
  const { context: c } = boot([cover]);
  const raw = frame({ action: 'play', song: '演员', artist: '薛之谦' });
  assert.equal(await c.applyMusicReply(raw, { type: 'play', title: '演员' }), '正在播放《演员》· 另一位歌手');
  c.fetch = async () => Response.json({ result: { songs: [actor] } });
  c.execTagSwitch = async () => false;
  assert.equal(await c.applyMusicReply(raw, { type: 'play' }), '找到了《演员》，但这个版本暂时无法播放。');
});

test('catalog aliases allow trusted translation and composite artist names without accepting a cover', async () => {
  const { context: c } = boot([
    { id: 1, name: 'The Truth That You Leave', ar: [{ name: 'Pianoboy高至豪', alias: ['高至豪'] }] },
    { id: 2, name: 'Merry Christmas Mr. Lawrence', tns: ['圣诞快乐劳伦斯先生'], ar: [{ name: '坂本龍一', tns: ['坂本龙一'] }] },
    { id: 3, name: '夜曲', ar: [{ name: '翻唱歌手' }] },
  ]);
  assert.equal((await c.verifyMusicTrack('The Truth That You Leave', 'Pianoboy'))[0].id, '1');
  assert.equal((await c.verifyMusicTrack('圣诞快乐劳伦斯先生', '坂本龙一'))[0].id, '2');
  assert.equal((await c.verifyMusicTrack('夜曲', '周杰伦')).length, 0);
});

test('unknown fields, URL fields, invalid JSON and commands outside current intent do not execute', async () => {
  const { context: c, calls } = boot();
  const malformed = [
    frame({ action: 'play', song: '演员', artist: '薛之谦', id: 21 }),
    frame({ action: 'play', song: 'https://example.invalid', artist: '薛之谦' }),
    frame({ action: 'pause', url: 'https://example.invalid' }),
    '[JSON_START]{"action":"pause"[JSON_END]',
    frame({ action: 'play', song: '演员', artist: '薛之谦' }) + '\n附加文本',
  ];
  for (const output of malformed) assert.equal(c.parseMusicAction(output), null);
  await c.applyMusicReply(frame({ action: 'play', song: '演员', artist: '薛之谦' }), { type: 'recommend' });
  assert.deepEqual(calls, []);
});

test('search and audio failures produce different status messages without false success', async () => {
  const { context: c, calls } = boot([]);
  const output = frame({ action: 'play', song: '演员', artist: '薛之谦' });
  assert.match(await c.applyMusicReply(output, { type: 'play' }), /没有找到/);
  assert.ok(!calls.some(Array.isArray));
  c.fetch = async () => Response.json({ result: { songs: [actor] } });
  c.execTagSwitch = async () => false;
  assert.match(await c.applyMusicReply(output, { type: 'play' }), /暂时无法播放/);
});

test('controls act on the current track, resume real state and do not toggle off a repeated favorite', async () => {
  const { context: c } = boot();
  c.currentSong = { id: '21', name: '演员' };
  c.audio.paused = false;
  c.togglePlay = async () => { c.audio.paused = false; return true; };
  let favorites = 0;
  c.isFavorited = () => favorites > 0;
  c.toggleFavorite = () => favorites++;
  c.nextSong = async () => { c.currentSong = { id: '25', name: '晴天' }; };
  c.prevSong = async () => { c.currentSong = { id: '21', name: '演员' }; };
  for (const [action, phrase] of [['pause', /已暂停/], ['resume', /继续/], ['replay', /从头/],
    ['favorite', /已收藏/], ['favorite', /已经在收藏/], ['next', /晴天/], ['previous', /演员/]]) {
    assert.match(await c.applyMusicReply(frame({ action }), { type: action }), phrase);
  }
  assert.equal(favorites, 1);
  assert.equal(c.audio.currentTime, 0);
  assert.match(await c.applyMusicReply(frame({ action: 'pause' }), { type: 'pause', currentId: '25' }), /已经换了/);
  assert.equal(c.audio.paused, false);
});

test('complete old instructions in history and incomplete current SSE cannot trigger playback', async () => {
  const { context: c, calls, labels } = boot();
  const legacy = frame({ song: '演员', artist: '薛之谦' });
  c.chatContext.push({ role: 'assistant', content: legacy });
  let complete = false;
  c.fetch = async url => {
    calls.push(url);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: complete ? '知道了' : legacy } }] }) +
      '\n\n' + (complete ? 'data: [DONE]\n\n' : ''));
  };
  await c.runChatReply('放一首《演员》', { type: 'play', title: '演员' }, null, { isConnected: true, querySelector: () => ({ append() {} }) });
  assert.match(labels.at(-1), /没有完整结束/);
  complete = true;
  await c.runChatReply('你好', null, null, { isConnected: true });
  assert.deepEqual(calls, ['/api/chat', '/api/chat']);
});
