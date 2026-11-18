'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const fixtureTrack = (id = '1') => ({ id, name: '歌曲 ' + id, artist: '歌手', cover: '', url: 'do not copy' });
const success = { ok: true };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function script(context, file) {
  vm.runInContext(readFileSync(join(__dirname, '../web/js', file), 'utf8'), context, { filename: file });
}
function fixture(load = async () => success) {
  let serial = 0;
  let clock = 1000;
  const context = vm.createContext({ document: { getElementById: () => null }, AbortController,
    crypto: { randomUUID: () => 'id-' + (++serial) } });
  script(context, '18-playback-queue.js');
  const calls = [];
  const queue = context.createPlaybackQueue({
    id: () => 'id-' + (++serial), now: () => clock,
    load: (track, signal) => { calls.push({ id: track.id, signal }); return load(track, signal); },
  });
  return { queue, calls, tick: () => { clock += 500; } };
}
const entries = queue => Array.from(queue.state.entries, entry => entry.track.id);
const statuses = queue => Array.from(queue.state.entries, entry => entry.status);

test('batch append is idle and explicit playlist playback prioritizes its order without deleting old pending tracks', async () => {
  const { queue, calls } = fixture();
  assert.equal(queue.addMany([fixtureTrack('1'), fixtureTrack('2')]), 2);
  assert.equal(queue.state.status, 'idle');
  assert.equal(calls.length, 0);
  assert.equal(await queue.playTracks([fixtureTrack('3'), fixtureTrack('4')]), true);
  assert.deepEqual(entries(queue), ['3', '4', '1', '2']);
  assert.deepEqual(statuses(queue), ['playing', 'pending', 'pending', 'pending']);
  queue.ended(false);
  await settle();
  assert.deepEqual(calls.map(call => call.id), ['3', '4']);
});

test('queue is separate and transient, validates ID, and retains duplicate entries without source URLs', () => {
  const { queue, calls } = fixture();
  assert.equal(queue.add(fixtureTrack()), true);
  assert.equal(queue.add(fixtureTrack()), true);
  assert.equal(queue.add(fixtureTrack('https://invalid.test')), false);
  assert.deepEqual(entries(queue), ['1', '1']);
  assert.notEqual(queue.state.entries[0].entryId, queue.state.entries[1].entryId);
  assert.equal(queue.state.entries[0].track.url, undefined);
  assert.equal(queue.state.entries[0].addedAt, 1000);
  queue.ended(false);
  assert.equal(queue.state.status, 'idle');
  assert.equal(calls.length, 0);
  assert.equal(fixture().queue.state.entries.length, 0);
});

test('remove, move and insert target exact entries and update revision', () => {
  const { queue } = fixture();
  for (const id of ['1', '2', '3', '4']) queue.add(fixtureTrack(id));
  const [one, two, three, four] = queue.state.entries;
  queue.move(three.entryId, -1);
  assert.deepEqual(entries(queue), ['1', '3', '2', '4']);
  queue.move(three.entryId, 1);
  queue.move(four.entryId, 'first');
  assert.deepEqual(entries(queue), ['4', '1', '2', '3']);
  queue.remove(two.entryId);
  assert.deepEqual(entries(queue), ['4', '1', '3']);
  assert.equal(queue.state.revision, 8);
  assert.equal(queue.remove('unknown'), false);
  assert.equal(queue.move(one.entryId, 5), false);
});

test('start marks playing only after media confirmation and ended moves through distinct duplicate IDs', async () => {
  const attempt = deferred();
  const { queue, calls } = fixture(track => calls.length === 1 ? attempt.promise : success);
  queue.add(fixtureTrack());
  queue.add(fixtureTrack());
  const start = queue.start();
  assert.equal(queue.state.status, 'active');
  assert.equal(queue.state.currentEntryId, null);
  assert.deepEqual(statuses(queue), ['pending', 'pending']);
  attempt.resolve(success);
  await start;
  assert.deepEqual(statuses(queue), ['playing', 'pending']);
  const first = queue.state.currentEntryId;
  queue.ended(false);
  await settle();
  assert.notEqual(queue.state.currentEntryId, first);
  assert.deepEqual(statuses(queue), ['played', 'playing']);
  queue.ended(false);
  await settle();
  assert.deepEqual(statuses(queue), ['played', 'played']);
  assert.equal(queue.state.status, 'exhausted');
  await queue.next();
  assert.equal(calls.length, 2);
});

test('clearing removes only pending entries and aborts a loading next track', async () => {
  const attempt = deferred();
  const { queue, calls, tick } = fixture(track => track.id === '1' ? success : attempt.promise);
  queue.add(fixtureTrack('1'));
  queue.add(fixtureTrack('2'));
  await queue.start();
  const first = queue.state.currentEntryId;
  tick();
  const switching = queue.next();
  queue.clear();
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(queue.state.currentEntryId, first);
  assert.deepEqual(statuses(queue), ['playing']);
  attempt.resolve(success);
  await switching;
  assert.equal(queue.state.currentEntryId, first);
  queue.ended(false);
  assert.equal(queue.state.status, 'exhausted');
});

test('removing the current pending request cancels it and safely starts the next entry', async () => {
  const slow = deferred();
  const { queue, calls } = fixture(track => track.id === '1' ? slow.promise : success);
  queue.add(fixtureTrack('1'));
  queue.add(fixtureTrack('2'));
  const starting = queue.start();
  queue.remove(queue.state.entries[0].entryId);
  await settle();
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(statuses(queue), ['playing']);
  slow.resolve(success);
  await starting;
  assert.deepEqual(entries(queue), ['2']);
});

test('queue distinguishes failures, skips them, and stops after three with remaining entries intact', async () => {
  const outcomes = ['no-source', 'audio-load', 'browser-play'];
  const { queue, calls } = fixture(track => outcomes[Number(track.id) - 1]
    ? { ok: false, outcome: outcomes[Number(track.id) - 1] } : success);
  for (const id of ['1', '2', '3', '4']) queue.add(fixtureTrack(id));
  await queue.start();
  assert.deepEqual(statuses(queue), ['failed', 'failed', 'failed', 'pending']);
  assert.deepEqual(Array.from(queue.state.entries.slice(0, 3), entry => entry.outcome), outcomes);
  assert.equal(queue.state.status, 'exhausted');
  assert.match(queue.message, /连续 3 首/);
  await queue.next();
  assert.equal(calls.length, 3);
  await queue.start();
  assert.deepEqual(statuses(queue), ['failed', 'failed', 'failed', 'playing']);
});

test('a current track can finish after a halted switch without reactivating the queue', async () => {
  const { queue, calls, tick } = fixture(track => track.id === '1' ? success : { ok: false, outcome: 'no-source' });
  for (const id of ['1', '2', '3', '4', '5']) queue.add(fixtureTrack(id));
  await queue.start();
  tick();
  await queue.next();
  assert.equal(queue.state.status, 'exhausted');
  assert.equal(queue.state.entries[0].status, 'playing');
  queue.ended(false);
  assert.equal(queue.state.entries[0].status, 'played');
  assert.equal(queue.state.currentEntryId, null);
  assert.equal(queue.state.entries[4].status, 'pending');
  assert.equal(calls.length, 4);
});

test('preview end is reported as restricted and only advances within the started queue', async () => {
  const { queue, calls } = fixture();
  queue.add(fixtureTrack());
  await queue.start();
  queue.ended(true);
  assert.equal(queue.state.entries[0].status, 'skipped');
  assert.equal(queue.state.entries[0].outcome, 'preview');
  assert.match(queue.message, /试听/);
  assert.equal(calls.length, 1);
});

test('manual exit preserves pending items and prevents late completion from changing a newer run', async () => {
  const old = deferred();
  const { queue, calls } = fixture(() => calls.length === 1 ? old.promise : success);
  queue.add(fixtureTrack('1'));
  queue.add(fixtureTrack('2'));
  const starting = queue.start();
  queue.leave();
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(statuses(queue), ['pending', 'pending']);
  await queue.start();
  const playing = queue.state.currentEntryId;
  old.resolve({ ok: false, outcome: 'no-source' });
  await starting;
  assert.equal(queue.state.currentEntryId, playing);
  assert.deepEqual(statuses(queue), ['playing', 'pending']);
});

test('rapid next and concurrent ended consume just one next track', async () => {
  const slow = deferred();
  const { queue, calls, tick } = fixture(track => track.id === '2' ? slow.promise : success);
  for (const id of ['1', '2', '3']) queue.add(fixtureTrack(id));
  await queue.start();
  tick();
  const next = queue.next();
  queue.ended(false);
  await queue.next();
  assert.deepEqual(calls.map(call => call.id), ['1', '2']);
  slow.resolve(success);
  await next;
  await queue.next();
  assert.deepEqual(statuses(queue), ['played', 'playing', 'pending']);
  assert.deepEqual(calls.map(call => call.id), ['1', '2']);
});

function playerFixture() {
  const audio = new EventTarget();
  Object.assign(audio, {
    paused: true, ended: false, currentTime: 0, duration: 180, error: null, src: '',
    load() { this.ended = false; this.error = null; this.paused = true; },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
    removeAttribute() { this.src = ''; },
    async play() {
      this.paused = false;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
    },
  });
  const node = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, setAttribute() {}, getContext: () => ({}),
    getBoundingClientRect: () => ({ width: 0 }), removeAttribute() {},
  });
  const context = vm.createContext({
    AbortController, Event, setTimeout, clearTimeout, crypto: { randomUUID: require('node:crypto').randomUUID },
    document: { getElementById: id => id === 'audioEl' ? audio : id === 'playbackQueuePanel' ? null : node(), querySelector: node },
    window: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    NE_API: '/ncm', localStorage: { getItem: () => '' }, addAIMsg() {},
    fetch: async url => {
      if (url.includes('/song/url')) {
        const id = new URL(url, 'http://local').searchParams.get('id');
        return Response.json({ data: [{ id, url: '/mock-audio/' + id }] });
      }
      return Response.json({});
    },
  });
  for (const file of ['04-player.js', '06-audio.js', '18-playback-queue.js']) script(context, file);
  vm.runInContext('updatePlayerUI = song => { currentSong = song; }', context);
  return { context, audio, evaluate: expression => vm.runInContext(expression, context) };
}

test('daily recommendation verifies the source, loads lyrics, then records a successful playback', async () => {
  const { context, audio, evaluate } = playerFixture();
  const lyrics = deferred();
  const recorded = [];
  const requests = [];
  context.recordDailyRecommendation = track => recorded.push(track.id);
  context.fetch = async url => {
    const target = new URL(url, 'http://local');
    requests.push(target.pathname);
    if (target.pathname.endsWith('/song/url')) return Response.json({ data: [{ id: '21', url: '/mock-audio/21' }] });
    return lyrics.promise;
  };
  context.track = { id: '21', song: '第一首', artist: '歌手' };

  const starting = evaluate('execTagSwitch(track, true)');
  await settle();
  assert.deepEqual(requests, ['/ncm/song/url', '/ncm/lyric']);
  assert.equal(audio.paused, true);
  assert.deepEqual(recorded, []);
  lyrics.resolve(Response.json({ lrc: { lyric: '[00:00.00]当前歌词' } }));
  assert.equal(await starting, true);
  assert.equal(audio.paused, false);
  assert.deepEqual(recorded.map(String), ['21']);
  assert.equal(evaluate('currentSong.lyrics[0].l'), '当前歌词');
});

test('clicking other tracks during playback appends them in click order and waits for the current song', async () => {
  const { context, audio, evaluate } = playerFixture();
  evaluate('currentSong = { id: "21", name: "当前歌曲", artist: "歌手", url: "/mock-audio/21" }; playHistory.push(currentSong);');
  assert.equal(evaluate('enqueueClickedTrack({ id: "22", name: "歌曲二", artist: "歌手" }, {})'), false);
  await audio.play();
  assert.equal(evaluate('enqueueClickedTrack(currentSong, {})'), false);
  const feedback = {};
  context.feedback = feedback;
  assert.equal(evaluate('enqueueClickedTrack({ id: "invalid", name: "歌曲", artist: "歌手" }, feedback, { showSuccess: false })'), true);
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /无法加入队列/);
  assert.equal(evaluate('enqueueClickedTrack({ id: "22", name: "歌曲二", artist: "歌手" }, feedback, { showSuccess: false })'), true);
  assert.equal(feedback.hidden, true);
  assert.equal(feedback.textContent, '');
  assert.equal(evaluate('enqueueClickedTrack({ id: "23", name: "歌曲三", artist: "歌手" }, {})'), true);
  assert.equal(evaluate('playbackQueue.state.status'), 'waiting');
  assert.equal(evaluate('playbackQueue.state.entries.map(entry => entry.track.id).join(",")'), '22,23');
  assert.equal(evaluate('currentSong.id'), '21');
  assert.equal(audio.paused, false);

  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));
  await settle();
  assert.equal(evaluate('String(currentSong.id)'), '22');
  assert.equal(evaluate('playbackQueue.state.entries.find(entry => entry.status === "pending").track.id'), '23');
});

test('inserting a next track waits for the current audio and prioritizes the inserted track', async () => {
  const { queue, calls } = fixture();
  queue.add(fixtureTrack('1'));
  assert.equal(queue.insertNext(fixtureTrack('2'), true), true);
  assert.equal(queue.state.status, 'waiting');
  assert.deepEqual(entries(queue), ['2', '1']);
  assert.deepEqual(calls, []);
  queue.ended(false);
  await settle();
  assert.deepEqual(calls.map(call => call.id), ['2']);
  assert.equal(queue.state.status, 'active');
});

test('scheduling without current audio stays idle and removing the only scheduled song disarms the queue', () => {
  const { queue, calls } = fixture();
  assert.equal(queue.insertNext(fixtureTrack('1')), true);
  assert.equal(queue.state.status, 'idle');
  queue.clear();
  assert.equal(queue.insertNext(fixtureTrack('2'), true), true);
  queue.remove(queue.state.entries[0].entryId);
  assert.equal(queue.state.status, 'idle');
  assert.deepEqual(calls, []);
});

test('an audio ending during lookup waits for the scheduled song instead of asking the model', async () => {
  const { context, audio, evaluate } = playerFixture();
  const lookup = deferred();
  const calls = [];
  context.AbortSignal = AbortSignal;
  context.fetch = async url => {
    const target = new URL(url, 'http://local');
    calls.push(target.pathname);
    if (target.pathname.endsWith('/cloudsearch')) return lookup.promise;
    if (target.pathname.endsWith('/song/url')) return Response.json({ data: [{ id: '25', url: '/mock-audio/25' }] });
    return Response.json({});
  };
  script(context, '17-music-companion.js');
  evaluate('currentSong = { id: "21", name: "当前歌曲", artist: "歌手", url: "/mock-audio/21" }; playHistory.push(currentSong);');
  context.requestNextRecommendation = async () => { calls.push('model'); };
  const scheduling = evaluate('queueNextTrack({ title: "彩券", artist: "薛之谦" }, new AbortController().signal)');
  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));
  await settle();
  assert.deepEqual(calls, ['/ncm/cloudsearch']);
  lookup.resolve(Response.json({ result: { songs: [{ id: 25, name: '彩券', ar: [{ name: '薛之谦' }] }] } }));
  assert.match(await scheduling, /已安排下一首/);
  await settle();
  assert.equal(evaluate('String(currentSong.id)'), '25');
  assert.equal(audio.paused, false);
  assert.deepEqual(calls, ['/ncm/cloudsearch', '/ncm/song/url', '/ncm/lyric']);
});

test('production player waits for audio start before writing history and reports browser failure', async () => {
  const { context, audio, evaluate } = playerFixture();
  const media = deferred();
  audio.play = () => media.promise;
  context.track = fixtureTrack('2');
  evaluate('playbackQueue.add(track)');
  const starting = evaluate('playbackQueue.start()');
  await settle();
  assert.equal(evaluate('playHistory.length'), 0);
  assert.equal(evaluate('currentSong'), null);
  assert.equal(evaluate('playbackQueue.state.entries[0].status'), 'pending');
  media.resolve();
  await starting;
  assert.equal(evaluate('playHistory.length'), 1);
  assert.equal(evaluate('playbackQueue.state.entries[0].status'), 'playing');
  audio.play = async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
  context.track = fixtureTrack('3');
  evaluate('playbackQueue.add(track)');
  await evaluate('playbackQueue.start()');
  assert.equal(evaluate('playHistory.length'), 1);
  assert.equal(evaluate('playbackQueue.state.entries[1].outcome'), 'browser-play');
});

test('production player separates missing source from audio decode failure and never records either', async () => {
  const { context, audio, evaluate } = playerFixture();
  context.track = fixtureTrack();
  context.fetch = async url => Response.json(url.includes('/song/url') ? { data: [] } : {});
  evaluate('playbackQueue.add(track)');
  await evaluate('playbackQueue.start()');
  assert.equal(evaluate('playbackQueue.state.entries[0].outcome'), 'no-source');
  context.track = fixtureTrack('2');
  context.fetch = async url => Response.json(url.includes('/song/url') ? { data: [{ id: '2', url: '/broken' }] } : {});
  audio.play = async () => {
    audio.error = { code: 4 };
    audio.dispatchEvent(new Event('error'));
    throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  };
  evaluate('playbackQueue.add(track)');
  await evaluate('playbackQueue.start()');
  assert.equal(evaluate('playbackQueue.state.entries[1].outcome'), 'audio-load');
  assert.equal(evaluate('playHistory.length'), 0);
});

test('production direct playback cancels a stale source fetch and keeps the queued item pending', async () => {
  const { context, evaluate } = playerFixture();
  const delayed = deferred();
  let signal;
  context.track = fixtureTrack();
  context.fetch = async (url, options) => {
    if (url.includes('/song/url?id=1')) { signal = options.signal; return delayed.promise; }
    return Response.json(url.includes('/song/url') ? { data: [{ id: '2', url: '/direct' }] } : {});
  };
  evaluate('playbackQueue.add(track)');
  const starting = evaluate('playbackQueue.start()');
  await settle();
  assert.equal(await evaluate("playOnlineMusic('手动歌曲','歌手',true,0,'2',{verified:true})"), true);
  assert.equal(signal.aborted, true);
  delayed.resolve(Response.json({ data: [{ id: '1', url: '/stale' }] }));
  await starting;
  assert.equal(evaluate('currentSong.name'), '手动歌曲');
  assert.equal(evaluate('playHistory.length'), 1);
  assert.equal(evaluate('playbackQueue.state.entries[0].status'), 'pending');
  assert.equal(evaluate('playbackQueue.state.status'), 'idle');
});

test('previous from history cancels in-flight browser playback before changing media', async () => {
  const { context, audio, evaluate } = playerFixture();
  await evaluate("playOnlineMusic('历史甲','歌手',true,0,'2',{verified:true})");
  await evaluate("playOnlineMusic('历史乙','歌手',true,0,'3',{verified:true})");
  const delayed = deferred();
  const normalPlay = audio.play;
  audio.play = function () {
    return this.src === '/mock-audio/1' ? delayed.promise : normalPlay.call(this);
  };
  context.track = fixtureTrack();
  evaluate('playbackQueue.add(track)');
  const starting = evaluate('playbackQueue.start()');
  await settle();
  assert.equal(audio.src, '/mock-audio/1');
  await evaluate('prevSong()');
  delayed.resolve();
  await starting;
  assert.equal(audio.src, '/mock-audio/2');
  assert.equal(evaluate('currentSong.name'), '历史甲');
  assert.equal(evaluate('playHistory.length'), 2);
  assert.equal(evaluate('playbackQueue.state.entries[0].status'), 'pending');
});

test('production ended suppresses old AI after queue exhaustion and idle next preserves legacy behavior', async () => {
  const { context, audio, evaluate } = playerFixture();
  let ai = 0;
  context.requestNextRecommendation = async () => ai++;
  context.track = fixtureTrack();
  evaluate('playbackQueue.add(track)');
  await evaluate('playbackQueue.start()');
  audio.paused = true;
  audio.ended = true;
  audio.dispatchEvent(new Event('ended'));
  await evaluate('nextSong()');
  assert.equal(ai, 0);
  assert.equal(evaluate('playbackQueue.state.status'), 'exhausted');
  evaluate('playbackQueue.leave()');
  await evaluate('nextSong()');
  assert.equal(ai, 1);
});
