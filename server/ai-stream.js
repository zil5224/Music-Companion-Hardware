'use strict';

const credentials = require('../web/js/00-credentials');

const END_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call']);
const MAX_FRAME = 128 * 1024;

async function sendAIStream(body, res, exact, failure) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Keep enough lookbehind to identify split credential prefixes and the exact Key.
  // CJK prose can be emitted earlier at a boundary that cannot split an ASCII token.
  const guard = Math.max(160, exact.length + 16);
  const asciiKey = /^[\x00-\x7f]*$/.test(exact);
  const lineSafeKey = !exact.includes('\n');
  let pending = '';
  let buffer = '';
  let data = [];
  let event = '';
  let frameSize = 0;
  let done = false;
  let finished = false;

  function write(content, reason) {
    const delta = content ? { content } : {};
    const choices = [{ delta, ...(reason ? { finish_reason: reason } : {}) }];
    res.write('data: ' + JSON.stringify({ choices }) + '\n\n');
  }

  function fail(code) {
    done = true;
    failure(code);
    if (!res.destroyed) res.write('event: error\ndata: ' + JSON.stringify({
      error: { code, message: '模型回复暂时不可用，请稍后重试。' },
    }) + '\n\n');
  }

  function flush(reason, final = false) {
    if (credentials.unsafeOutput(pending, exact)) {
      fail('ai_stream_sensitive');
      return;
    }
    let boundary = pending.length;
    if (!final) {
      boundary = Math.max(0, pending.length - guard);
      // Credential patterns are single-line. Keep the lookbehind for a Key containing LF.
      if (lineSafeKey) boundary = Math.max(boundary, pending.lastIndexOf('\n') + 1);
      if (asciiKey) {
        const prose = pending.match(/^[\u3400-\u9fff\u3001-\u303f\uff01\uff0c\uff1f]+/u);
        if (prose) boundary = Math.max(boundary, prose[0].length);
      }
    }
    if (boundary && /[\ud800-\udbff]/.test(pending[boundary - 1])) boundary--;
    if (boundary || reason) write(pending.slice(0, boundary), reason);
    pending = pending.slice(boundary);
  }

  function dispatch() {
    const payload = data.join('\n').trim();
    const type = event;
    data = [];
    event = '';
    frameSize = 0;
    if (type === 'error') return fail('ai_stream_error');
    if (!payload) return;
    if (payload === '[DONE]') {
      flush(null, true);
      if (!done) res.write('data: [DONE]\n\n');
      done = true;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(payload); }
    catch { return fail('ai_stream_invalid'); }
    if (parsed?.error) return fail('ai_stream_error');
    const choice = parsed?.choices?.[0];
    if (!choice || finished) return;
    if (typeof choice.delta?.content === 'string') pending += choice.delta.content;
    const reason = END_REASONS.has(choice.finish_reason) ? choice.finish_reason : null;
    flush(reason, Boolean(reason));
    finished = Boolean(reason);
  }

  function line(value) {
    if (!value) return dispatch();
    frameSize += value.length;
    if (frameSize > MAX_FRAME) return fail('ai_stream_invalid');
    if (value.startsWith('event:')) event = value.slice(6).trim();
    if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
  }

  try {
    while (!done && !res.destroyed) {
      const chunk = await reader.read();
      if (res.destroyed) break;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      // Split all SSE line endings, retaining a CR at the end of a transport chunk.
      const lines = buffer.split(chunk.done ? /\r\n|\r|\n/ : /\r\n|\n|\r(?!$)/);
      buffer = lines.pop();
      for (const value of lines) {
        line(value);
        if (done) break;
      }
      if (done) break;
      if (buffer.length > MAX_FRAME) { fail('ai_stream_invalid'); break; }
      if (chunk.done) {
        if (buffer) line(buffer);
        if (!done) dispatch();
        if (!done) flush(null, true);
        break;
      }
    }
  } catch {
    if (!done && !res.destroyed) fail('ai_stream_disconnected');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    if (!res.destroyed) res.end();
  }
}

module.exports = { sendAIStream };
