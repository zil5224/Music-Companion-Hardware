'use strict';

// Shared by the browser and Node. Browser code never receives the configured Key.
const ZilyCredentials = (() => {
  const placeholder = '[凭证已隐藏]';
  const notice = '检测到疑似凭证。请删除或替换凭证后重新发送。';
  const keyField = /^(?:authorization|proxy[-_]authorization|(?:set[-_])?cookie|(?:[\w-]+[-_])?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key)|password|passwd|secret|token|session[-_]id|netease_cookie|MUSIC_U|MUSIC_A|NMTID|__csrf|zily_memory)$/i;
  const placeholderValue = /^(?:your[-_][\w-]+|(?:example|placeholder|replace[-_]?me|redacted|changeme|process\.env\.[\w]+|os\.environ|import\.meta\.env|undefined|null|true|false)(?:[-_]\w+)?|x{4,}|\*+|<[^>]+>|\$\{[^}]+\}|\$[A-Z_][\w]*)$/i;
  const token = /\b(?:sk[-_][\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,}|xox[baprs]-[\w-]{12,}|AIza[\w-]{35}|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[\w-]{16,}|gsk_[\w-]{16,}|ya29\.[\w.-]{12,}|eyJ[\w-]{6,}\.[\w-]{8,}\.[\w-]{8,})\b/i;
  const header = /\b(?:Bearer[ \t]{1,32}[\w.+~/-]{12,}|(?:proxy-)?Authorization[ \t]{0,16}:[ \t]{0,32}(?:Basic|Digest)[ \t]{1,32}[\w+/=-]{8,}|(?:Set-)?Cookie[ \t]{0,16}:[ \t]{0,32}[\w.-]+[ \t]{0,16}=[ \t]{0,16}[^;\s"'<>]+)/i;
  const pem = /-----BEGIN (?:[A-Z0-9]+ ){0,5}(?:PRIVATE KEY|CERTIFICATE)-----/i;
  const userInfo = /\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\/\/[^/\s:@]+:[^/\s@]+@/i;
  const assignment = /\b(?:[\w-]+[-_])?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key|password|passwd|secret|token|session[-_]?id|(?:set[-_])?cookie|authorization|netease_cookie|MUSIC_U|MUSIC_A|NMTID|__csrf|zily_memory)\b["']?[ \t]{0,16}[:=][ \t]{0,32}(?:"([^"\r\n]+)("|$)|'([^'\r\n]+)('|$)|([\w.+/~%-]{1,512}))/gi;
  const location = /(?:\b[A-Z]:[\\/][^\s"'<>]+|(?:^|[\s("'=])\/(?:home|Users|tmp|var|srv|opt|app|workspace|workspaces|mnt|private|etc)\/[^\s"'<>]+|(?:^|\n)[ \t]*at[ \t]+[^\r\n]*(?:node:[\w/.-]+|:\d+:\d+\)?))/im;
  const configured = () => typeof module !== 'undefined' && module.exports ? process.env.DEEPSEEK_API_KEY : '';

  function contains(text, exact = configured()) {
    if (typeof text !== 'string' || !text) return false;
    if (exact && text.includes(exact)) return true;
    const normalized = text.normalize('NFKC');
    if (token.test(normalized) || header.test(normalized) || pem.test(normalized) || userInfo.test(normalized)) return true;
    for (const match of normalized.matchAll(assignment)) {
      const value = (match[1] ?? match[3] ?? match[5]).trim();
      if (value && !placeholderValue.test(value) &&
          (value.length >= 8 || match[2] === '"' || match[4] === "'" ||
            /(?:MUSIC_[UA]|NMTID|__csrf|zily_memory|netease_cookie)[ \t]*[:=]/i.test(match[0]))) return true;
    }
    return false;
  }

  function inData(value, exact = configured()) {
    if (typeof value === 'string') return contains(value, exact);
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(entry => inData(entry, exact));
    return Object.entries(value).some(([key, entry]) =>
      (typeof entry === 'string' && !!entry.trim() && keyField.test(key) && !placeholderValue.test(entry.trim())) ||
      contains(key, exact) || inData(entry, exact));
  }

  function redact(text, exact) {
    return contains(text, exact) ? placeholder : text;
  }

  function unsafeOutput(text, exact) {
    return contains(text, exact) || location.test(text);
  }

  async function checkLocal(payload) {
    const response = await fetch('/api/privacy/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    }).catch(() => { throw new Error('暂时无法完成本机凭证检查，请稍后重试。'); });
    if (response.status === 204) return;
    const error = await response.json().catch(() => null);
    if (error?.code === 'credential_detected') throw new Error(notice, { cause: 'credential_detected' });
    throw new Error('暂时无法完成本机凭证检查，请稍后重试。');
  }

  return { contains, inData, redact, unsafeOutput, checkLocal, placeholder, notice };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyCredentials;
