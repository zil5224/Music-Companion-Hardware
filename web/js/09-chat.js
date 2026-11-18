// ═══════════════════════════════════════════════════════════════
//  CHAT — DeepSeek-V4 大脑 + 网易云音乐联动
// ═══════════════════════════════════════════════════════════════

function addUMsg(t){
  const d=document.createElement('div'); d.className='flex items-start gap-2 justify-end';
  d.innerHTML='<div class="msg-user px-3 py-2.5 text-sm max-w-[78%]" style="border-radius:12px 12px 2px 12px">'+escHTML(t)+'</div>';
  chatMsgs.appendChild(d); scrollChat();
}
function addAIMsg(t){
  const d=document.createElement('div'); d.className='flex items-start gap-2';
  d.innerHTML='<div class="msg-ai px-3 py-2.5 text-sm max-w-[78%]" style="border-radius:2px 12px 12px 12px">'+t+'</div>';
  chatMsgs.appendChild(d); scrollChat();
  return d;
}
function addErrMsg(t){
  const d=document.createElement('div'); d.className='flex items-start gap-2';
  d.innerHTML='<div class="px-3 py-2.5 text-sm max-w-[78%]" style="border-radius:2px 12px 12px 12px;background:rgba(40,10,10,0.78);border:1px solid rgba(255,70,70,0.22);color:#f66;font-family:\'Share Tech Mono\',monospace;font-size:11px">'+escHTML(t)+'</div>';
  chatMsgs.appendChild(d); scrollChat();
}
function scrollChat(){ chatMsgs.scrollTop=chatMsgs.scrollHeight; }

function setAIMessageText(container, text){
  const el=container.querySelector('.msg-ai');
  if(el) el.textContent = text || '';
  scrollChat();
}

function getVisibleStreamText(raw){
  const marker = '[JSON_START]';
  const idx = raw.indexOf(marker);
  if(idx >= 0) return raw.slice(0, idx).trimEnd();
  for(let i = marker.length - 1; i > 0; i--){
    if(raw.endsWith(marker.slice(0, i))) return raw.slice(0, -i);
  }
  return raw;
}

function stripPlaybackClosing(text, music = false) {
  const closing = /\r?\n[ \t]*(?:(?:那就|我来|我给你|要不要|要不)[，, \t]*)?(?:播放|放|播)(?:一下)?(?:这(?:一)?首(?:歌)?|下(?:一)?首(?:歌)?)(?:吧|吗)?[。！？!?]?[ \t\r\n]*$/u.exec(text);
  if (!closing) return text;
  const explanation = text.slice(0, closing.index).trimEnd();
  return explanation && (music || /《[^》]+》|歌词|旋律|编曲|曲风/.test(explanation)) ? explanation : text;
}

function parseCommand(text){
  const re=/\[COMMAND:\s*play_music,\s*tag:\s*([^\]]+)\]/i;
  const m=text.match(re);
  if(!m) return {clean:text, tag:null};
  return {clean:text.replace(re,'').replace(/\n{2,}/g,'\n').trim(), tag:m[1].trim()};
}

function parseSongDirective(text){
  try {
    const raw = text || '';
    const marker = raw.match(/\[JSON_START\]\s*({[\s\S]*?})\s*\[JSON_END\]/i);
    if(marker){
      const jsonText = marker[1].replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      const data = JSON.parse(jsonText);
      const song = String(data.song || data.title || '').trim();
      const artist = String(data.artist || '').trim();
      if(song){
        return {
          clean: raw.replace(marker[0], '').replace(/\n{3,}/g, '\n\n').trim(),
          tag: {song, artist}
        };
      }
    }
  } catch(e){
    console.warn('[SONG_DIRECTIVE] JSON 解析失败');
  }
  return parseCommand(text);
}

function wantsMusic(text, previousReply = ''){
  const input = text.trim();
  if (/^(?:我(?:现在|今天|暂时)?\s*)?(?:不想听|不听|不要|别|不用|先不|暂时不)/.test(input)) return false;

  const priorTrack = /《[^》]+》|这首歌|给你推荐一首/.test(previousReply);
  if (priorTrack && /^(?:那(?:就)?|好[，,\s]*|行[，,\s]*)?(?:(?:放|播|播放)(?:它|这首(?:歌)?|吧|啊|呀|一下)*|就这首(?:歌)?(?:吧)?)[。！？!?]*$/.test(input)) return true;
  if (/^(?:怎么|为什么)(?:还|没|没有|不|还没|还不|没有在|没在)*(?:给我)?(?:播放|放|播)\s*[^？?。，！!\s][^。！？?！!]{0,48}[。！？?!]?$/.test(input)) return true;

  return /(?:^|[，,。！？；\s])(?:(?:我(?:现在|今天|这会儿)?|现在|请|能不能|可以|帮我|给我)[，, ]*)*(?:想听(?:歌|音乐|一首|点歌|点音乐|《|[^。！？？，,]{1,40}(?:的歌(?:曲)?|歌曲))|放首|放一首|放点(?:歌|音乐)|来首|来一首|来点(?:歌|音乐)|点歌|换首|换一首|下一首|播放|放歌|听歌|随便来一首)/.test(input);
}

function musicRequest(text, previousReply = '', forcePlay = false) {
  if (forcePlay) return { type: 'play' };
  const input = text.trim().replace(/[。！？!?]+$/u, '');
  const command = input.replace(/^(?:请|帮我|给我|麻烦你)\s*/u, '');
  if (/^(?:别|不要|不用|暂时不|先不)/u.test(command)) return null;
  if (typeof playlistRequest === 'function') {
    const playlist = playlistRequest(input);
    if (playlist) return playlist;
    if (/^(?:播放|放)(?:这|那)(?:份|张|个)?歌单$/u.test(command)) return { type: 'discuss' };
  }
  const scheduled = /^(?:下一首(?:歌)?\s*(?:就\s*)?(?:播放|放|播)|等(?:这首(?:歌)?|当前歌曲)?(?:播完|放完)[，,\s]*(?:再\s*)?(?:播放|放|播))\s*(.+)$/u.exec(command);
  if (scheduled) {
    const target = scheduled[1].trim();
    const quoted = /^(?:(.+?)的\s*)?《([^《》]+)》$/u.exec(target);
    if (quoted) return { type: 'queue_next', title: quoted[2].trim(), artist: quoted[1]?.trim() || '' };
    const qualified = /^([^《》的]{1,40})的(.+)$/u.exec(target);
    return qualified ? { type: 'queue_next', title: qualified[2].trim(), artist: qualified[1].trim(), fallbackTitle: target }
      : { type: 'queue_next', title: target, artist: '' };
  }
  const controls = {
    pause: /^(?:暂停(?:一下|播放)?|先暂停|先停一下)(?:吧)?$/u,
    resume: /^(?:继续播放|继续听|接着播放|恢复播放)(?:吧)?$/u,
    next: /^(?:下一首|切下一首)(?:吧)?$/u,
    previous: /^(?:上一首|切上一首)(?:吧)?$/u,
    favorite: /^(?:把这首歌?收藏起来|收藏(?:当前歌曲|这首歌?|一下)?)(?:吧)?$/u,
    replay: /^(?:再放一遍|重播(?:当前歌曲|这首歌?)?|再播一遍|单次重播)(?:吧)?$/u,
    similar: /^(?:换|放)(?:一)?首类似的(?:歌(?:曲)?)?(?:吧)?$/u,
  };
  const control = Object.keys(controls).find(action => controls[action].test(command));
  if (control) return { type: control };
  const approval = /^(?:(?:那就|那|好[，,]?|行[，,]?)\s*)?(?:放|播|播放|就)(?:这首(?:歌)?|它|第[一二三123]首)?(?:啊|呀|一下|吧)?$/u.exec(command);
  if (approval && (wantsMusic(input, previousReply) || /第[一二三123]首/u.test(command))) {
    return { type: 'play', confirmation: true, selection: '一二三'.indexOf(command.match(/第([一二三])/u)?.[1]) + 1 ||
      Number(command.match(/第([123])/u)?.[1] || 0) };
  }
  const explicit = /(?:^|[，,。！？；])\s*(?:(?:请|帮我|给我|现在|我想你|能不能|可以)\s*)*(?:放(?:一)?首|放点|播放|放歌|点歌|来(?:一)?首|来点|换(?:一)?首|给我放)/u.test(input);
  const musicTopic = /歌|音乐|曲风|钢琴|专辑|旋律|薛之谦|周杰伦/u.test(input);
  if (!explicit && /^(?:听歌|听音乐).+(?:吗|么|呢|为什么)$/u.test(input)) return { type: 'discuss' };
  if (!explicit && ((musicTopic && /推荐|有没有类似|相似的歌/u.test(input)) ||
      /(?:想听|想找).{0,30}(?:轻快|安静|有故事感|深夜|类似|风格)/u.test(input) ||
      (/^(?:再推荐|还有类似)/u.test(input) && /《[^》]+》|这首歌/u.test(previousReply)))) {
    return { type: 'recommend' };
  }
  if (!explicit && !wantsMusic(input, previousReply) &&
      /^(?:我)?想听(?!你|听|我|他|她|什么|点)[\p{L}\d· ]{1,18}$/u.test(input)) return { type: 'recommend' };
  if (explicit || wantsMusic(input, previousReply)) {
    const title = input.match(/《([^《》]{1,100})》/u)?.[1] ||
      input.match(/^(?:怎么|为什么).{0,8}(?:播放|放)([\p{L}\d· ]{1,100})$/u)?.[1];
    const artist = input.match(/(?:放(?:一)?首|播放|点歌)\s*([\p{L}\d·]{1,30})的《/u)?.[1] ||
      input.match(/(?:想听|放(?:一)?首|播放)([\p{L}\d·]{1,30})的歌/u)?.[1];
    return { type: 'play', title, artist };
  }
  if (/这首歌|这段歌词|音乐风格|歌曲风格|歌手|歌词|专辑|薛之谦|周杰伦|《[^》]+》/u.test(input)) return { type: 'discuss' };
  return null;
}



const CHAT_BODY_LIMIT = 64 * 1024;
const CHAT_MESSAGE_LIMIT = 8000;
const CHAT_HISTORY_LIMIT = 18;

function chatRequestBody(messages, maxTokens, temperature, options) {
  return JSON.stringify({ ...options, messages, temperature, max_tokens: maxTokens });
}

function chatBodyFits(body) {
  return new TextEncoder().encode(body).byteLength <= CHAT_BODY_LIMIT;
}

function selectChatHistory(history, current, options) {
  let selected = [];
  let end = history.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && history[start].role === 'assistant') start--;
    const turn = history.slice(start, end).map(({ role, content }) => ({ role, content }));
    if (turn.length + selected.length > CHAT_HISTORY_LIMIT ||
        turn.some(message => message.content.length > CHAT_MESSAGE_LIMIT)) break;
    const candidate = [...turn, ...selected];
    if (!chatBodyFits(chatRequestBody([...candidate, current], 1400, 0.7, options))) break;
    selected = candidate;
    end = start;
  }
  return selected;
}

async function callAIStream(userInput, onDelta, music = false, signal, onComplete){
  const playlist = music?.type === 'playlist_draft';
  const options = {
    mode: music ? 'music' : companionMode,
    musicIntent: music?.type,
    musicContext: music?.type && typeof musicPlayerContext === 'function' ? musicPlayerContext(music.type) : undefined,
    onComplete,
    summary: playlist ? undefined : conversationSummary.text,
    ...(playlist ? { playlistCount: music.count, playlistRepeat: music.repeat, playlistReference: music.reference } : {}),
    replyLength: companionPreferences.length,
    suggestMusic: companionPreferences.suggestMusic,
    recentPlayed: music === true ? getRecentPlayedList().slice(0, 800) : ''
  };
  const current = { role: 'user', content: userInput };
  const history = playlist ? [] : selectChatHistory(conversationMessages(), current, options);
  const maxTokens = playlist ? Math.min(2000, 1000 + music.count * 80) : 1400;
  return streamChatMessages([...history, current], onDelta, signal, maxTokens, 0.7, options);
}

async function streamChatMessages(messages, onDelta, signal, maxTokens = 1400, temperature = 0.85, options = {}){
  const body = chatRequestBody(messages, maxTokens, temperature, options);
  if (messages.some(message => message.content.length > CHAT_MESSAGE_LIMIT) || !chatBodyFits(body)) {
    throw new Error('这条消息太长，请分段发送。');
  }
  const resp=await fetch(CHAT_API,{
    signal,
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body
  });
  if(!resp.ok){
    if (options.mode === 'summary') throw new Error('摘要请求失败（HTTP ' + resp.status + '）', { cause: 'summary-http' });
    const problem = await resp.json().catch(() => null);
    if (problem?.code === 'credential_detected') {
      throw new Error(ZilyCredentials.notice, { cause: 'credential_detected' });
    }
    if (problem?.code === 'ai_unconfigured') {
      throw new Error('请在服务端配置自己的模型 API Key。', { cause: 'ai_unconfigured' });
    }
    throw new Error('模型请求失败，请检查配置或稍后重试。', { cause: 'ai_request_failed' });
  }
  if(!resp.body) {
    if (options.mode === 'summary') throw new Error('摘要流没有响应体');
    return ZilyCredentials.redact(await resp.text());
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let completed = false;
  let incomplete = null;
  let reachedEOF = false;

  function readEventLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      completed = true;
      return true;
    }

    let data;
    try { data = JSON.parse(payload); } catch { return false; }
    if (data?.error) {
      throw new Error('模型回复暂时不可用，请稍后重试。', { cause: 'interrupted' });
    }
    const choice = data?.choices?.[0];
    const reason = choice?.finish_reason;
    if (reason === 'stop') completed = true;
    else if (reason && !incomplete) incomplete = reason;

    const content = choice?.delta?.content;
    if (typeof content === 'string' && content) {
      fullText += content;
      if (ZilyCredentials.contains(fullText)) {
        if (onDelta) onDelta(ZilyCredentials.placeholder);
        throw new Error('模型回复暂时不可用，请稍后重试。', { cause: 'interrupted' });
      }
      if (onDelta) onDelta(fullText);
    }
    return false;
  }

  try {
    let doneMarker = false;
    while (!doneMarker) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) {
        reachedEOF = true;
        readEventLine(buffer + decoder.decode());
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (readEventLine(line)) {
          doneMarker = true;
          break;
        }
      }
    }
  } finally {
    // An upstream can keep the connection open after [DONE].
    if (!reachedEOF) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (options.mode === 'summary' && incomplete === 'length') {
    throw new Error('摘要输出达到长度限制', { cause: 'summary-length' });
  }
  if (options.mode === 'summary' && (!completed || incomplete)) {
    throw new Error('摘要流未完整结束', { cause: 'summary-incomplete' });
  }
  if (completed && !incomplete) options.onComplete?.();
  return fullText;
}

function isSearchFollowUp(text){
  const query = text.trim();
  return /^(?:那|所以|然后|她|他|它|这个|那个|这位|那位).{0,45}(?:哪一期|什么时候|是谁|哪里|第几期|哪一集|叫啥|叫什么|怎么回事)/.test(query) ||
    /^(?:那(?:就)?[，, ]*)?(?:你[，, ]*)?(?:现在[，, ]*)?(?:再|去)?(?:了解|关注)(?:一下|一些|一点|下)(?:吧|吗)?[。！!？?]*$/.test(query);
}

function needsWebSearch(text, followingSearch = false){
  const query = text.trim();
  if (/^(?:别|不要|不用|不必|无需)(?:帮我)?(?:联网|搜索|查)/.test(query)) return false;
  if (/^(?:(?:请|能不能|可以|帮我|给我)\s*)*(?:查一下|查一查|查查|搜一下|搜索|联网查|网上查)/.test(query)) return true;
  if (followingSearch && isSearchFollowUp(query)) return true;
  const topical = /综艺|节目|电视剧|电影|新剧|新闻|热搜|比赛|赛程|政策|发布|天气|票价|汇率|股价|开播|上映|嘉宾|热播/.test(query);
  const current = /最近|今天|昨天|明天|最新|本周|这周|现在|目前|刚出的|新出的/.test(query);
  const question = /[？?]|有没有|有了解|知道|怎么样|什么时候|几点|是谁|有哪些|多少|什么|如何|怎么|吗[。！]?$/.test(query);
  return question && (topical && current || /什么时候(?:开播|上映)|(?:今天|明天).{0,10}天气|节目.{0,15}嘉宾都有谁/.test(query));
}

let chatPending = false;
let activeChat = null;

function cancelPlaylistChat() {
  if (!activeChat?.playlistDraft) return;
  const controller = activeChat;
  activeChat = null;
  chatPending = false;
  controller.abort();
  if (controller.playlistContainer?.isConnected) setAIMessageText(controller.playlistContainer, '已取消歌单生成。');
  document.getElementById('chatSendLabel').textContent = '发送';
}

function handleChatSend(){
  if (activeChat?.playlistDraft && musicRequest(chatInput.value)?.type === 'playlist_draft') {
    return sendMessage();
  }
  if (activeChat) activeChat.abort();
  else sendMessage();
}

async function sendMessage(forceMusic = false, requestedText, referenceSnapshot){
  if (chatPending && !activeChat?.playlistDraft) return;
  const text = forceMusic ? '来首歌' : requestedText ?? chatInput.value;
  if(!text.trim()) return;
  if (ZilyCredentials.contains(text)) {
    addErrMsg(ZilyCredentials.notice);
    return;
  }
  if (text.length > CHAT_MESSAGE_LIMIT) {
    addAIMsg('这条消息超过了 8000 字符，请分段发送。');
    return;
  }
  if (!forceMusic) {
    const activeConversation = chatContext;
    try { await ZilyCredentials.checkLocal({ message: text }); }
    catch (error) {
      addErrMsg(error?.cause === 'credential_detected' ? ZilyCredentials.notice : '暂时无法完成本机凭证检查，请稍后重试。');
      return;
    }
    if (chatContext !== activeConversation) return;
  }
  const previousReply = chatContext.at(-1);
  const reference = forceMusic ? null : referenceSnapshot ? { reference: referenceSnapshot } :
    typeof playlistLibrary !== 'undefined' ? playlistReferenceIntent(text, playlistLibrary.read) : null;
  if (reference?.error) {
    addAIMsg(reference.error);
    return;
  }
  const music = reference ? { ...(playlistRequest(text) || { type: 'playlist_draft', count: 6, repeat: false }),
    reference: reference.reference } :
    musicRequest(text, previousReply?.role === 'assistant' ? previousReply.content : '', forceMusic);
  if (chatPending) {
    if (music?.type !== 'playlist_draft') return;
    cancelPlaylistChat();
  }
  if (music && typeof currentSong !== 'undefined') music.currentId = currentSong?.id ?? null;
  if(!forceMusic && requestedText === undefined) chatInput.value='';
  chatInput.focus();
  addUMsg(text);
  if(text.includes('摸摸蛙')||text.includes('奶蛙')||text.includes('子夜')) triggerBearBoost();
  const canSearch = !music || music.type === 'discuss';
  const topic = canSearch ? recentSearchTopic() : [];
  const clarification = canSearch ? searchClarificationContext(text) : [];
  const search = canSearch && (clarification.length > 0 || needsWebSearch(text, topic.length > 0))
    ? { context: clarification.length ? clarification : isSearchFollowUp(text) ? topic : [] }
    : null;
  await runChatReply(text, search ? null : music, search, addAIMsg(''), forceMusic);
}

async function runChatReply(text, music, search, container, dailyRecommendation = false, retryTurn){
  if (chatPending || !container.isConnected) return;
  if (ZilyCredentials.contains(text)) {
    setAIMessageText(container, ZilyCredentials.notice);
    return;
  }
  if (retryTurn && !retryConversationTurn(retryTurn)) {
    conversationStatus('这条旧回复无法在原处重试，请重新发送消息。');
    return;
  }
  const turn = retryTurn || beginConversationTurn(text);
  const reply = turn[1];
  chatPending = true;
  const controller = new AbortController();
  controller.playlistDraft = music?.type === 'playlist_draft';
  if (controller.playlistDraft) {
    clearPlaylistPreview();
    controller.playlistContainer = container;
  }
  activeChat = controller;
  const label = document.getElementById('chatSendLabel');
  label.textContent = '停止';
  let playlist = null;
  let searched = false;
  let streamComplete = false;
  let awaitingSearchClarification = false;
  let persistence = saveConversation();
  controller.signal.addEventListener('abort', () => {
    finishConversationTurn(turn, 'cancelled');
    persistence = flushConversationCheckpoint();
    if (activeChat === controller && container.isConnected) setAIMessageText(container, conversationReplyText(reply));
  }, { once: true });
  try {
    if (music?.type === 'queue_next') {
      setAIMessageText(container, '正在网易云核对歌曲…');
      reply.content = await queueNextTrack(music, controller.signal);
      controller.signal.throwIfAborted();
      setAIMessageText(container, reply.content);
    } else if (search) {
      setAIMessageText(container, '正在查资料…');
      const result = await answerWithSearch(text, container, controller.signal, search.context);
      controller.signal.throwIfAborted();
      reply.content = result.answer;
      searched = result.searched;
      awaitingSearchClarification = result.awaitingSearchClarification;
    } else {
      setAIMessageText(container, '正在回复…');
      const raw = await callAIStream(text, partial => {
        if (activeChat !== controller || controller.signal.aborted || controller.playlistDraft) return;
        const visible = stripPlaybackClosing(getVisibleStreamText(partial), Boolean(music));
        if (visible === reply.content) return;
        reply.content = visible;
        setAIMessageText(container, visible);
        checkpointConversation();
      }, music, controller.signal, () => { streamComplete = true; });
      controller.signal.throwIfAborted();
      if (!streamComplete) {
        const message = controller.playlistDraft ? '歌单回复没有完整结束，可以重试。'
          : music?.type && music.type !== 'discuss' ? '这轮回复没有完整结束，播放器保持当前状态。' : '回复没有完整结束。';
        throw new Error(message, { cause: 'interrupted' });
      }
      if (!raw.trim()) throw new Error('模型返回了空回复。');
      if (controller.playlistDraft) {
        const draft = parsePlaylistDraft(raw, music.count);
        if (!draft) throw new Error('歌单回复格式或首数不符合要求，可以重新生成。');
        setAIMessageText(container, '正在按顺序核对歌单曲目…');
        playlist = await verifyPlaylistDraft(draft, music, controller.signal);
        controller.signal.throwIfAborted();
        reply.content = '临时歌单 · ' + playlist.name;
      } else if (music && typeof applyMusicReply === 'function') {
        const result = await applyMusicReply(raw, music, dailyRecommendation, controller.signal,
          status => setAIMessageText(container, status));
        controller.signal.throwIfAborted();
        reply.content = result;
      } else {
        reply.content = stripPlaybackClosing(parseSongDirective(raw).clean);
      }
      setAIMessageText(container, reply.content);
    }
    const discover = streamComplete && !search && (!music || music.type === 'discuss');
    finishConversationTurn(turn, 'completed', searched, awaitingSearchClarification, discover);
    persistence = flushConversationCheckpoint();
    if (playlist) renderPlaylistPreview(container, playlist, text, music.reference);
    if (typeof bindMusicRecommendation === 'function') bindMusicRecommendation(reply);
    if (typeof renderQueueRecommendationActions === 'function') renderQueueRecommendationActions(container, reply);
    void refreshConversationSummary();
  } catch (error) {
    if (activeChat !== controller || !container.isConnected) return;
    const stopped = controller.signal.aborted;
    if (error?.cause === 'credential_detected') turn[0].content = ZilyCredentials.placeholder;
    if (reply.status === 'streaming') {
      const status = reply.content || error?.cause === 'interrupted' ? 'interrupted' : 'failed';
      finishConversationTurn(turn, status);
      persistence = flushConversationCheckpoint();
    }
    const safeFailure = ['credential_detected', 'ai_unconfigured', 'ai_request_failed'].includes(error?.cause);
    const note = stopped ? '已停止' : safeFailure || search || controller.playlistDraft ||
      (music && error?.cause === 'interrupted') ? error.message : '';
    setAIMessageText(container, conversationReplyText(reply, note));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mood-chip reply-retry';
    retry.textContent = '重试';
    retry.onclick = () => runChatReply(turn[0].content, music, search, container, dailyRecommendation, turn);
    if (error?.cause !== 'credential_detected') container.querySelector('.msg-ai').append(retry);
  } finally {
    if (activeChat === controller) {
      activeChat = null;
      chatPending = false;
      label.textContent = '发送';
    }
  }
  await persistence;
}
