'use strict';

const { createHash } = require('node:crypto');

const REJECTION_COOLDOWN = 7 * 24 * 60 * 60_000;
const REPEAT_REQUEST = /(?:^|[。！？!?；;\n])\s*(?:请|麻烦)?(?:你)?(?:帮我)?(?:再记一次|重新记一下|重新记住|再记一下|再记住)(?:这(?:件事|个偏好|条记忆|一点))?(?=$|[\s。！？!?；;：:])/u;
const CORRECTION = /(?:之前|以前|原先)[^。！？!?；;\n]{0,32}(?:说错了|不准确|搞错了)|(?:我)?(?:改口|改主意|收回之前|更正一下|现在改为|现在改用)/u;

function exactKey(content) {
  return content.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function fingerprint(content) {
  return createHash('sha256').update(exactKey(content)).digest('hex');
}

function legacySignature(content) {
  const text = exactKey(content).toLowerCase()
    .replace(/^(?:用户|我(?:的)?)/u, '')
    .replace(/(?:一直|通常|平时|长期|比较|很|更|特别|最)/gu, '')
    .replace(/(?:偏爱|偏好|爱好|爱听|喜欢听)/gu, '喜欢')
    .replace(/[^\p{L}\p{N}]/gu, '');
  const units = [...text];
  const tokens = units.slice(1).map((char, i) => units[i] + char);
  return { negative: /不|拒绝|讨厌|避免|取消|反对|改用|更换/u.test(text), tokens: new Set([...new Set(tokens)].slice(0, 100)) };
}

function legacyMatch(a, b) {
  if (a.negative !== b.negative) return 0;
  let overlap = 0;
  for (const token of a.tokens) if (b.tokens.has(token)) overlap++;
  const ratio = overlap / Math.max(a.tokens.size, b.tokens.size);
  return overlap >= 3 && ratio >= 0.72 ? ratio : 0;
}

function compact(text) {
  return exactKey(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function clauses(content) {
  return content.normalize('NFKC')
    .split(/[。！？!?；;\n]+|[,，](?=\s*(?:但|也希望|我|希望|不喜欢|使用|采用|计划|想要|更倾向))/u)
    .map(compact).filter(clause => clause.length >= 4);
}

function preferenceClaim(clause) {
  const match = /^(?:但(?:是)?|也)?(?:我|用户)?(?:一直|通常|平时|比较|很|更)*(不太喜欢|不喜欢|讨厌|喜欢|偏爱)(?:听|看)?(.{2,})$/u.exec(clause);
  if (!match) return undefined;
  return { negative: /^(?:不|讨厌)/u.test(match[1]), subject: match[2] };
}

function grams(parts, size) {
  const terms = new Set();
  for (const part of parts) {
    for (let i = 0; i <= part.length - size; i++) terms.add(part.slice(i, i + size));
  }
  return terms;
}

function inspect(memory) {
  const parts = clauses(memory.content);
  return { memory, parts, legacy: legacySignature(memory.content), preferences: parts.map(preferenceClaim).filter(Boolean) };
}

function sharedPhrase(left, terms, size) {
  for (let i = 0; i <= left.length - size; i++) {
    const phrase = left.slice(i, i + size);
    if (terms.has(phrase)) return phrase;
  }
  return '';
}

function projectGoal(parts) {
  const [lead, ...details] = parts;
  if (!lead || !details.length) return null;
  const direct = /^我打算长期(?:经营|运营|继续做)(.+)$/u.exec(lead);
  const continued = /^(.+?)这个项目我打算长期做下去$/u.exec(lead);
  const project = direct?.[1] || continued?.[1];
  return project ? { project, details } : null;
}

function sameProjectGoal(left, right) {
  if (left.memory.category !== 'goal' || right.memory.category !== 'goal') return null;
  const a = projectGoal(left.parts);
  const b = projectGoal(right.parts);
  if (!a || !b || a.project !== b.project || a.details.length !== b.details.length ||
      !a.details.every((part, index) => part === b.details[index])) return null;
  return a.project;
}

function opposingPreference(left, right) {
  if (left.negative === right.negative) return false;
  if (left.subject === right.subject) return true;
  const negative = left.negative ? left : right;
  const positive = left.negative ? right : left;
  const scope = /^(.*(?:听|播放))音乐$/u.exec(negative.subject);
  return !!scope && positive.subject === scope[1] + '纯音乐';
}

function communicationSupplement(candidate, target) {
  if (candidate.memory.category !== 'preference' || target.memory.category !== 'preference') return false;
  const negativeFormal = /^(?:我)?不(?:太)?喜欢[^。]{0,28}(?:官方|客服式|像客服)[^。]{0,28}(?:交流|表达|聊天|对话)/u;
  const natural = /自然[^。]{0,14}(?:交流|表达|聊天|对话)/u;
  return candidate.parts.some(part => negativeFormal.test(part)) &&
    target.preferences.some(claim => !claim.negative && natural.test(claim.subject)) &&
    !target.parts.some(part => negativeFormal.test(part));
}

function compare(candidate, target) {
  const opposition = candidate.preferences.find(claim =>
    target.preferences.some(old => opposingPreference(claim, old)));
  if (opposition) return {
    type: 'possible_conflict', rank: 4, score: opposition.subject.length,
    reason: '对同一对象或包含关系的范围「' + opposition.subject + '」出现了方向相反的偏好表述。',
  };

  const project = sameProjectGoal(candidate, target);
  if (project) return {
    type: 'possible_duplicate', rank: 2, score: 2,
    reason: '两条内容均表达长期推进「' + project + '」及相同的后续目标，未发现新增分句。',
  };
  const legacy = legacyMatch(candidate.legacy, target.legacy);
  const anchors = candidate.parts.map(part => {
    for (const size of [8, 6]) {
      const phrase = sharedPhrase(part, target.grams[size], size);
      if (phrase) return phrase;
    }
    return '';
  });
  const covered = anchors.filter(Boolean);
  const shared = covered.sort((a, b) => b.length - a.length)[0];
  if (shared && covered.length < candidate.parts.length) {
    return { type: 'possible_supplement', rank: 3, score: covered.length,
      reason: '共享措辞「' + shared + '」，候选还有未匹配的分句。' };
  }
  if (legacy || (shared && candidate.parts.every(part => target.parts.includes(part)))) {
    return { type: 'possible_duplicate', rank: 2, score: legacy || covered.length,
      reason: legacy ? '字符对相似度约 ' + Math.round(legacy * 100) + '%，请核对是否包含新信息。'
        : '候选中的分句与已有记忆一致。' };
  }
  if (communicationSupplement(candidate, target)) return {
    type: 'possible_supplement', rank: 3, score: 1,
    reason: '两条内容都涉及交流风格，候选进一步表达了对官方或客服式表达的偏好。',
  };
  const short = shared || (candidate.memory.category === target.memory.category &&
    candidate.parts.map(part => sharedPhrase(part, target.grams[4], 4)).find(Boolean));
  if (short) return { type: 'related_unresolved', rank: 1, score: short.length,
    reason: '共享措辞「' + short + '」，本地规则无法确认两条记忆的关系。' };
  return undefined;
}

function createRelationLookup(memories, candidates = []) {
  const order = new Map(candidates.map((item, index) => [item.id, index]));
  const targets = [
    ...memories.filter(item => item.status === 'active'),
    ...candidates.filter(item => item.status === 'pending'),
  ].filter(item => typeof item.content === 'string').map(memory => {
    const target = inspect(memory);
    target.grams = { 4: grams(target.parts, 4), 6: grams(target.parts, 6), 8: grams(target.parts, 8) };
    return target;
  });
  return candidate => {
    const source = inspect(candidate);
    let active;
    let pending;
    const position = order.get(candidate.id);
    for (const target of targets) {
      if (candidate.id === target.memory.id) continue;
      const match = compare(source, target);
      if (!match) continue;
      const origin = target.memory.status;
      const previous = origin === 'active' ? active : pending;
      const earlier = origin === 'pending' && order.get(target.memory.id) < position;
      const result = { ...match, earlier, target: { id: target.memory.id, content: target.memory.content, source: origin } };
      if (!previous || match.rank > previous.rank || (match.rank === previous.rank &&
          (earlier !== previous.earlier ? earlier : match.score > previous.score))) {
        if (origin === 'active') active = result;
        else pending = result;
      }
    }
    const preferPending = !active || (active.type !== 'possible_conflict' &&
      (pending?.type === 'possible_conflict' || (pending?.type === 'possible_duplicate' && pending.earlier)));
    const best = preferPending ? pending : active;
    const other = preferPending ? active : pending;
    if (!best) return { type: 'independent' };
    const correction = candidate.correctionCue || (candidate.evidence || []).some(item => item.role === 'user' && hasCorrectionCue(item.quote));
    const hint = ({ type, target, reason }) => ({ type, target,
      reason: reason + (correction ? ' 用户原话含有更正措辞，仍需核对更正对象。' : '') });
    return { ...hint(best), ...(other ? { other: hint(other) } : {}) };
  };
}

function rejectFingerprint(content, now) {
  return { digest: fingerprint(content), rejectedAt: new Date(now).toISOString(),
    suppressUntil: new Date(now + REJECTION_COOLDOWN).toISOString() };
}

function recentlyRejected(records, digest, now) {
  return records.some(record => record?.digest === digest && Date.parse(record.suppressUntil) > now);
}

function explicitlyRememberAgain(text) {
  return REPEAT_REQUEST.test(text);
}

function hasCorrectionCue(text) {
  return CORRECTION.test(text);
}

module.exports = { fingerprint, createRelationLookup, rejectFingerprint, recentlyRejected, explicitlyRememberAgain, hasCorrectionCue };
