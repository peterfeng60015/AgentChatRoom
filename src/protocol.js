// 訊息協定：第一行 `[TAG] 標題`，接著零或多行 `key: value`，空一行後是內文。

export const MODERATOR_TAGS = ['TOPIC', 'ASSIGN', 'GO', 'CONTINUE', 'STOP', 'CLOSE', 'ANSWER'];
export const AGENT_TAGS = ['JOIN', 'LEAVE', 'ACK', 'DISCUSS', 'QUESTION', 'PROGRESS', 'DONE', 'IDLE', 'INFO'];
export const ALL_TAGS = [...MODERATOR_TAGS, ...AGENT_TAGS];

export const FIELD_KEYS = [
  'repo',
  'base',
  'rounds',
  'role',
  'task',
  'branch',
  'isolation',
  'files',
  'percent',
  'eta',
  'vendor',
  'model',
  'host',
  'worktree',
  'commit',
  'to',
];

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISPLAY_NAME_LIMIT = 80;
export const ROLE_LIMIT = 40;
export const OWN_MESSAGE_KEEP = 50;
export const BROADCAST_NAMES = ['all', 'agents', 'everyone', 'here', '全體'];

// §6.1：輸出裡提示下一步的指令一律寫完整可執行的形式，帶 --as；wait 另外帶 --timeout。
export function waitTimeoutOf(room) {
  return Math.min(540, Math.max(0, Math.round(room?.waitTimeoutSec ?? 90)));
}
// room.roomArg 是 --room 給的名稱：用非預設房間時，提示也要帶 --room，照抄才不會跑到預設房間。
export function cmdText(name, sub, args = '', room = null) {
  const r = room?.roomArg ? ` --room ${room.roomArg}` : '';
  return `agentchat ${sub} --as ${name}${r}${args ? ` ${args}` : ''}`;
}
export function waitText(name, room, until) {
  return cmdText(name, 'wait', `${until ? `--until ${until} ` : ''}--timeout ${waitTimeoutOf(room)}`, room);
}

// 各階段允許的發言指令（§5.2）。wait、status、read 這類只讀指令不在這裡管。
export const PHASE_COMMANDS = {
  lobby: ['post', 'ask', 'leave'],
  topic: ['post', 'ask', 'leave'],
  discussion: ['ack', 'discuss', 'post', 'ask', 'leave'],
  work: ['progress', 'done', 'post', 'ask', 'leave'],
  done: ['post', 'ask', 'leave'],
  stopped: ['ask', 'leave'],
  closed: ['leave'],
  idle: ['leave'],
  left: [],
};

const TAG_SET = new Set(ALL_TAGS);
const FIELD_SET = new Set(FIELD_KEYS);
const BROADCAST = new Set(BROADCAST_NAMES);

// 半形 [TAG]、全形 【TAG】 與 ［TAG］，括號要成對。
const TAG_LINE_RE = /^\s*(?:\[\s*([A-Za-z]+)\s*\]|【\s*([A-Za-z]+)\s*】|［\s*([A-Za-z]+)\s*］)(.*)$/;
const FIELD_LINE_RE = /^\s*([A-Za-z]+)\s*[:：]\s*(.*)$/;

// §4.4 的 @ 位置：@ 或 ＠，前面是行首或不是 email 帳號字元（中文緊接也算），後面緊接非空白字元。
const AT_RE = /(?<![A-Za-z0-9_.+-])[@＠](?=\S)/g;
const DISCORD_USER_RE = /<@!?(\d+)>/g;
// Discord 選單產生的 <@使用者ID>、<@&角色ID> 裡的 @ 不是 @ 位置。
const DISCORD_MENTION_RE = /<@[!&]?\d+>/g;
const ASCII_WORD_CHAR = /[A-Za-z0-9_-]/;
const MODERATOR_ALIASES = ['moderator', '主導者'];

// 保留字：當名稱會和廣播或主導者 mention 混在一起。
export const RESERVED_NAMES = ['all', 'agents', 'everyone', 'here', 'moderator'];

export function validateAgentName(name) {
  if (!name || !NAME_RE.test(name)) {
    return '名稱只能用英數字、底線、連字號，開頭須為英數字，長度 1 到 31，例如 claude-1';
  }
  const lower = name.toLowerCase();
  if (lower.includes('discord') || lower.includes('clyde')) {
    return 'Discord 不允許名稱含有 discord 或 clyde';
  }
  // @moderator 只看開頭就換成主導者 mention，所以 moderator2 這類名稱也永遠 @ 不到。
  if (RESERVED_NAMES.includes(lower) || lower.startsWith('moderator')) {
    return `${name} 是保留字（${RESERVED_NAMES.join('、')}），請換一個名稱，例如 claude-1`;
  }
  return null;
}

// 解析標籤列與欄位列；headerLines 是標籤列加欄位列的行數，長文截斷時用來保留表頭。
export function parseMessageParts(content = '') {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const m = (lines[0] ?? '').match(TAG_LINE_RE);
  const tag = m ? (m[1] || m[2] || m[3]).toUpperCase() : null;
  if (!tag || !TAG_SET.has(tag)) {
    return { tag: null, title: '', fields: {}, body: lines.join('\n').trim(), headerLines: 0 };
  }
  const fields = {};
  let i = 1;
  // 欄位列必須緊接在標籤列之後，遇到第一個不是已知欄位的行（含空白行）就停。
  while (i < lines.length) {
    const fm = lines[i].match(FIELD_LINE_RE);
    if (!fm || !FIELD_SET.has(fm[1].toLowerCase())) break;
    fields[fm[1].toLowerCase()] = fm[2].trim();
    i++;
  }
  return { tag, title: m[4].trim(), fields, body: lines.slice(i).join('\n').trim(), headerLines: i };
}

export function parseMessage(content = '') {
  const { tag, title, fields, body } = parseMessageParts(content);
  return { tag, title, fields, body };
}

export function buildMessage(tag, title = '', fields = {}, body = '') {
  const lines = [`[${tag}]${title ? ' ' + title : ''}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${value}`);
  }
  if (body) lines.push('', body);
  return lines.join('\n');
}

// users 是 <@ID> 裡的 ID；at 是每個 @ 位置之後第一個字元的索引。
export function extractMentions(content = '') {
  const text = String(content ?? '');
  const users = [...text.matchAll(DISCORD_USER_RE)].map((m) => m[1]);
  const skip = [...text.matchAll(DISCORD_MENTION_RE)].map((m) => [m.index, m.index + m[0].length]);
  const at = [];
  for (const m of text.matchAll(AT_RE)) {
    if (!skip.some(([a, b]) => m.index >= a && m.index < b)) at.push(m.index + 1);
  }
  return { users, at };
}

// W 之後是不是邊界：W 以英數字、_、- 結尾時，下一字不能是這些字元；
// 以其他字元（例如中文）結尾時，下一字要是空白、- 與 _ 以外的標點或符號。
function isWordBoundary(word, next) {
  if (next === undefined) return true;
  const last = [...word].pop();
  if (ASCII_WORD_CHAR.test(last)) return !ASCII_WORD_CHAR.test(next);
  if (/\s/.test(next)) return true;
  if (next === '-' || next === '_') return false;
  return /[\p{P}\p{S}]/u.test(next);
}

// §4.4「@ 到 W」：某個 @ 位置之後的文字以 W 開頭（不分大小寫），而且 W 之後是邊界。
export function mentionsWord(text, word) {
  const w = String(word ?? '');
  if (!w) return false;
  const t = String(text ?? '');
  const lower = w.toLowerCase();
  for (const p of extractMentions(t).at) {
    if (t.slice(p, p + w.length).toLowerCase() !== lower) continue;
    const next = [...t.slice(p + w.length, p + w.length + 2)][0];
    if (isWordBoundary(w, next)) return true;
  }
  return false;
}

export function isBroadcastName(name) {
  return BROADCAST.has(String(name).toLowerCase());
}

function mentionsBroadcast(text) {
  return BROADCAST_NAMES.some((w) => mentionsWord(text, w));
}

export function isMentioned(content, self) {
  if (!self || !self.name) return false;
  return (
    mentionsWord(content, self.name) || (Boolean(self.role) && mentionsWord(content, self.role)) || mentionsBroadcast(content)
  );
}

function firstLineOf(content) {
  return String(content ?? '').replace(/\r\n?/g, '\n').split('\n')[0];
}

// 指令的作用對象只看第一行：有沒有 @ 位置、有沒有 @ 到廣播詞；對象比對交給 isTargeted。
export function targetsOf(content = '') {
  const first = firstLineOf(content);
  return { hasAt: extractMentions(first).at.length > 0, broadcast: mentionsBroadcast(first) };
}

// 被回覆的訊息是不是我發的：最近的 ownMessageIds，加上待答問題（掉出最近 50 則也認得）。
export function isReplyToMe(replyTo, self) {
  if (!replyTo || !self) return false;
  return (self.ownMessageIds || []).includes(replyTo) || self.pendingQuestionId === replyTo;
}

// §4.4「指令對我生效」。只有主導者的指令算數，所以帶了 kind 且不是 moderator 一律不生效。
// self 是 agent 狀態：沒 @ 的 [GO]／[CONTINUE]／[STOP] 要看 assigned、phase 與 phaseBeforeStop。
// 「第一行有 @」是第一行至少有一個 @ 位置；Discord 選單產生的 <@使用者ID> 不算。
export function isTargeted(msg, self) {
  if (!msg || !self || !self.name) return false;
  if (msg.kind && msg.kind !== 'moderator') return false;
  const tag = msg.tag;
  if (!tag) return false;
  const content = msg.content ?? `[${tag}]${msg.title ? ' ' + msg.title : ''}`;
  const first = firstLineOf(content);
  const { hasAt, broadcast } = targetsOf(content);
  const name = String(self.name).toLowerCase();
  const phase = self.left ? 'left' : self.phase;
  const named = broadcast || mentionsWord(first, self.name);
  switch (tag) {
    case 'TOPIC':
    case 'CLOSE':
      return true;
    case 'ASSIGN':
      return named;
    case 'ANSWER': {
      const to = String(msg.fields?.to ?? '')
        .split(/[,，、\s]+/)
        .map((x) => x.replace(/^[@＠]/, '').toLowerCase())
        .filter(Boolean);
      return named || to.includes(name) || isReplyToMe(msg.replyTo, self);
    }
    case 'GO':
    case 'CONTINUE':
    case 'STOP': {
      if (hasAt) {
        if (phase === 'left') return false;
        return named || (Boolean(self.role) && mentionsWord(first, self.role));
      }
      if (tag === 'STOP') return !['closed', 'idle', 'left'].includes(phase);
      if (self.assigned !== true) return false;
      if (phase === 'discussion') return true;
      // 停下前已經 done 的 agent 不會被沒 @ 的 GO／CONTINUE 拉回來。
      return phase === 'stopped' && ['discussion', 'work'].includes(self.phaseBeforeStop);
    }
    default:
      return false;
  }
}

// 主導者別名只看 @ 位置與開頭、不要求邊界（`@主導者決定` 也換）：寧可多通知，不要漏掉。
export function resolveMentions(text, room) {
  const t = String(text ?? '');
  let out = '';
  let last = 0;
  for (const p of extractMentions(t).at) {
    const alias = MODERATOR_ALIASES.find((a) => t.slice(p, p + a.length).toLowerCase() === a);
    if (!alias) continue;
    out += `${t.slice(last, p - 1)}<@${room.moderatorUserId}>`;
    last = p + alias.length;
  }
  return out + t.slice(last);
}

// 依 code point 截斷，避免把 emoji 等代理對切成半個；長度用 UTF-16 計，保證不超過上限。
function truncate(text, limit) {
  const chars = [...String(text)];
  let out = chars.join('');
  while (out.length > limit) {
    chars.pop();
    out = chars.join('');
  }
  return out;
}

export function displayName(name, role) {
  const n = String(name);
  if (!role) return truncate(n, DISPLAY_NAME_LIMIT);
  const full = `${n} (${role})`;
  if (full.length <= DISPLAY_NAME_LIMIT) return full;
  const room = DISPLAY_NAME_LIMIT - n.length - 3;
  if (room <= 0) return truncate(n, DISPLAY_NAME_LIMIT);
  return `${n} (${truncate(role, room)})`;
}

export function splitAgentName(username = '') {
  const m = String(username ?? '').match(/^(.*?)(?: \((.*)\))?$/s);
  return { name: m ? m[1] : username, role: m && m[2] ? m[2] : null };
}

// 名稱比對一律不分大小寫（§6.1）。
export function isSelfName(username = '', name) {
  if (!name) return false;
  const u = String(username ?? '').toLowerCase();
  const n = String(name).toLowerCase();
  return u === n || u.startsWith(`${n} (`);
}

// 角色會出現在 webhook 顯示名稱 `名稱 (角色)` 與 @角色 裡：刪掉會破壞格式或觸發 mention 的字元，
// 空白換成 -，讓角色一定能用 @角色 提到。
export function sanitizeRole(role) {
  if (role === undefined || role === null) return null;
  let cleaned = String(role)
    .replace(/[()（）[\]［］【】{}｛｝<>＜＞@＠#:：`]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Discord 拒收含 discord、clyde 的 webhook 名稱；換到不再出現為止（clclydeyde 這種換一次會再拼出來）。
  for (let prev = null; prev !== cleaned; ) {
    prev = cleaned;
    cleaned = cleaned.replace(/discord/gi, 'dc').replace(/clyde/gi, 'cl');
  }
  return truncate(cleaned, ROLE_LIMIT) || null;
}

// §4.5 作者身分。opts.webhookId 是本房 webhook；不知道時所有 webhook 訊息都算本房。
export function authorKind(raw, room, self, opts = {}) {
  if (raw?.author?.id && raw.author.id === room.moderatorUserId) return 'moderator';
  if (raw?.webhook_id) {
    if (opts.webhookId && raw.webhook_id !== opts.webhookId) return 'bot';
    if (self && isSelfName(raw.author?.username, self.name)) return 'self';
    return 'agent';
  }
  if (raw?.author?.bot) return 'bot';
  return 'human';
}

// Discord 的系統訊息（釘選、成員加入等）也帶 message_reference，只有一般訊息（0）與回覆（19）才算回覆。
export function isSystemMessage(raw) {
  return raw?.type !== undefined && raw.type !== 0 && raw.type !== 19;
}

function replyIdOf(raw) {
  const ref = raw?.message_reference;
  if (!ref || !ref.message_id || isSystemMessage(raw)) return null;
  // type 1 是轉傳（forward），不是回覆。
  if (ref.type !== undefined && ref.type !== 0) return null;
  return ref.message_id;
}

// 把 Discord 原始訊息整理成工具內部統一格式。
export function normalize(raw, room, self, opts = {}) {
  const kind = authorKind(raw, room, self, opts);
  const content = raw.content || '';
  const parsed = parseMessage(content);
  let author;
  let authorRole = null;
  if (kind === 'agent' || kind === 'self') {
    ({ name: author, role: authorRole } = splitAgentName(raw.author?.username));
  } else {
    author = raw.author?.global_name || raw.author?.username || '(未知)';
  }
  const replyTo = replyIdOf(raw);
  const msg = {
    id: raw.id,
    timestamp: raw.timestamp,
    kind,
    author,
    authorRole,
    authorId: raw.author?.id ?? null,
    content,
    tag: parsed.tag,
    title: parsed.title,
    fields: parsed.fields,
    body: parsed.body,
    mentionsMe: false,
    targetsMe: false,
    mentionsModerator:
      (raw.mentions || []).some((u) => u.id === room.moderatorUserId) ||
      extractMentions(content).users.includes(room.moderatorUserId),
    replyTo,
    attachments: (raw.attachments || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      url: a.url,
      contentType: a.content_type || null,
    })),
  };
  if (self && kind !== 'self') {
    msg.mentionsMe = isMentioned(content, self) || isReplyToMe(replyTo, self);
    msg.targetsMe = kind === 'moderator' && MODERATOR_TAGS.includes(parsed.tag) && isTargeted(msg, self);
  }
  return msg;
}

// code fence：開頭行是 ``` 加語言字串（不能再有反引號，所以同一行開又關的 ```inline``` 不算），
// 收尾行只有反引號，而且不短於開頭的標記。
const FENCE_OPEN_RE = /^\s*(`{3,})([^`]*)$/;
const FENCE_CLOSE_RE = /^\s*(`{3,})\s*$/;

// 在每段 ≤ budget 的前提下切段；fence 跨段時在段尾補收尾行、下一段開頭重開。
function splitByBudget(source, budget, { fences = true } = {}) {
  const chunks = [];
  let current = null; // 目前這段的行
  let head = 0; // 這段開頭由工具補上的重開行數（0 或 1）
  let openAt = -1; // 這段裡 fence 開頭行的位置（不是工具補的重開行）；-1 表示這段沒有開 fence
  let fence = null; // 目前所在的 fence：{ marker, reopen }

  const size = (lines, extra) => (lines.length ? lines.join('\n').length + 1 : 0) + extra.length;
  const flush = () => {
    let close = Boolean(fence);
    // fence 剛好在這段最後一行打開、還沒有內容：把開頭行留給下一段（下一段會用一模一樣的行重開），不留下空的區塊。
    // 用位置判斷，不比字串：fence 裡的內容行也可能剛好長得像開頭行。
    if (current && fence && current.length > head + 1 && openAt === current.length - 1 && current[openAt].trim() === fence.reopen) {
      current.pop();
      close = false;
    }
    if (current && current.length > head && current.some((l) => l.trim() !== '')) {
      const body = current.join('\n').replace(/\n+$/, '');
      chunks.push(close ? `${body}\n${fence.marker}` : body);
    }
    current = null;
  };
  const push = (line) => {
    if (current && size(current, line) > budget && current.length > head) flush();
    if (!current) {
      current = fence ? [fence.reopen] : [];
      head = current.length;
      openAt = -1;
    }
    current.push(line);
  };

  for (const line of source.split('\n')) {
    const closing = fences && fence && FENCE_CLOSE_RE.exec(line);
    if (closing && closing[1].length >= fence.marker.length) {
      // 收尾行放得下就放進這段；放不下就直接收段（flush 會補收尾行），不在下一段開一個空區塊。
      if (current && size(current, line) <= budget + fence.marker.length + 1) current.push(line);
      else flush();
      fence = null;
      continue;
    }
    const opening = !fences || fence ? null : FENCE_OPEN_RE.exec(line);
    // 開頭行：重開時只帶簡短的語言字串；把內容寫在 ``` 同一行時不重複那一大段。
    const next = opening
      ? { marker: opening[1], reopen: opening[1] + (/^[\w+.#-]{1,20}$/.test(opening[2].trim()) ? opening[2].trim() : '') }
      : null;
    const room = (f) => Math.max(1, budget - (f ? f.reopen.length + 1 : 0));
    if (line.length <= room(fence)) {
      push(line);
      if (next) {
        fence = next;
        openAt = current.length - 1;
      }
      continue;
    }
    // 單行就超過上限：硬切，但不切開代理對。開頭行的第一片放完就進入 fence，之後的片段跨段時才會補成對。
    let rest = [...line];
    while (rest.length) {
      let piece = '';
      let count = 0;
      const max = room(fence ?? next);
      while (count < rest.length && piece.length + rest[count].length <= max) piece += rest[count++];
      if (count === 0) piece = rest[count++];
      rest = rest.slice(count);
      push(piece);
      if (next && !fence) {
        fence = next;
        openAt = current.length - 1;
      }
    }
  }
  flush();
  return chunks;
}

// 把超過 Discord 上限的訊息切段：盡量在行邊界切，code fence 跨段時兩邊補成對，每段結尾加 (i/n)。
// (i/n) 的長度要看總段數，所以從一位數開始試，段數變多就加大預留再切一次。
export function splitMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const source = String(text ?? '');
  if (source.length <= limit) return [source];
  const markers = source.split('\n').map((l) => (l.match(/^\s*(`{3,})/) || [])[1]?.length ?? 0);
  const fenceReserve = Math.max(0, ...markers) ? Math.max(...markers) + 1 : 0;
  // limit 極小時補 fence 的行放不下，退回不處理 fence 的切法；連這樣都超過就是 limit 太小。
  for (const fences of fenceReserve ? [true, false] : [false]) {
    for (let digits = 1; digits <= 7; digits++) {
      const budget = Math.max(1, limit - (2 * digits + 4) - (fences ? fenceReserve : 0));
      let chunks = splitByBudget(source, budget, { fences });
      if (chunks.length <= 1) {
        if (!chunks.length) chunks = [source.slice(0, limit)];
        if (chunks[0].length <= limit) return chunks;
        continue;
      }
      if (String(chunks.length).length > digits) continue;
      const marked = chunks.map((c, i) => `${c}\n(${i + 1}/${chunks.length})`);
      if (marked.every((c) => c.length <= limit)) return marked;
      break;
    }
  }
  throw new RangeError(`splitMessage 的 limit 太小：${limit}`);
}

// 本段討論的則數上限：CONTINUE n > 議題的 rounds > 房間預設。
export function roundLimit(state, room) {
  if (Number.isInteger(state.discussLimit) && state.discussLimit > 0) return state.discussLimit;
  const fromTopic = parseInt(String(state.topic?.fields?.rounds ?? '').normalize('NFKC'), 10);
  if (Number.isFinite(fromTopic) && fromTopic > 0) return fromTopic;
  return room.maxDiscussionRounds;
}

// §5.5 作業 repo 的來源：[TOPIC] 的 repo > room.defaultRepo > 目前工作目錄。只有分工帶 branch 或 isolation 時才用得到。
export function topicRepoText(fields = {}, room) {
  let repo;
  if (fields.repo) repo = `${fields.repo}（[TOPIC] 指定）`;
  else if (room.defaultRepo) repo = `${room.defaultRepo}（房間預設）`;
  else repo = '未指定，有 branch 分工時用目前目錄（只有 isolation 時也一樣，用目前目錄所在的 git repo）';
  return `作業 repo：${repo}；基準分支：${fields.base || room.defaultBase}`;
}

function splitFiles(value) {
  if (!value) return null;
  const list = String(value)
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

// [CONTINUE] 的 n 要先去掉 @ 對象與 <@ID>，免得抓到 claude-1 的 1；全形數字（中文輸入法常見）先轉半形。
// @ 後面是英數字時只去掉最長的 [A-Za-z0-9_-]（`@claude-1再討論2輪` 留下「再討論2輪」），否則去到空白或標點為止。
function stripMentions(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(DISCORD_MENTION_RE, ' ')
    .replace(/(?<![A-Za-z0-9_.+-])[@＠](?:[A-Za-z0-9_][A-Za-z0-9_-]*|[^\s\p{P}]*)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRESENCE_TAGS = new Set(['JOIN', 'LEAVE', 'IDLE']);

// 逐則套用指令並依「套用當下」的狀態重算 mentionsMe、targetsMe（會改寫傳入的訊息物件），
// 讓輸出的「← 提到你」與實際生效的指令一致。回傳 { notes, targeted }。
export function applyEach(state, messages, room) {
  const notes = [];
  const targeted = [];
  for (const m of messages) {
    if (m.kind !== 'self') {
      m.mentionsMe = isMentioned(m.content, state) || isReplyToMe(m.replyTo, state);
      m.targetsMe = m.kind === 'moderator' && MODERATOR_TAGS.includes(m.tag) && isTargeted(m, state);
      if (m.targetsMe) targeted.push(m);
    }
    notes.push(...applyDirectives(state, [m], room));
  }
  return { notes, targeted };
}
export const LEFT_TEXT = '你已離開這個房間；除非開這個 session 的使用者要求，不要重新 join';

// 依序套用對我生效的主導者指令，回傳給 agent 看的「注意」。
// 對象判斷用「當下」的狀態，所以同一批裡先 [ASSIGN] 給角色、再 [GO] @角色 也會生效。
export function applyDirectives(state, messages, room) {
  const notes = [];
  for (const m of messages) {
    if (m.kind === 'self') continue;
    // §5.4：[JOIN]／[LEAVE]／[IDLE] 不論誰發的都不算有人回應，不重設無人回應的計時。
    const presence = PRESENCE_TAGS.has(m.tag);
    if (!presence) state.emptyWaitSince = null;
    if (m.kind !== 'moderator') continue;

    // §4.4：主導者用 Discord 回覆我的任何一則訊息，或不加標籤直接 @ 我的名稱，都視為回答了待答問題。
    if (state.pendingQuestionId && m.tag !== 'ANSWER') {
      const byReply = isReplyToMe(m.replyTo, state);
      const byName = !m.tag && mentionsWord(m.content, state.name);
      if (byReply || byName) {
        notes.push(`主導者${byReply ? '回覆了你' : '提到你'}（id=${m.id}），你的待答問題視為已回答，請依內容繼續。`);
        state.pendingQuestionId = null;
      }
    }
    if (!MODERATOR_TAGS.includes(m.tag) || !isTargeted(m, state)) continue;

    switch (m.tag) {
      case 'TOPIC':
        state.topic = {
          id: m.id,
          title: m.title,
          fields: m.fields,
          body: m.body,
          attachments: (m.attachments || []).map((a) => ({ filename: a.filename, size: a.size })),
        };
        state.phase = 'topic';
        state.role = null;
        state.task = null;
        state.branch = null;
        state.isolation = null;
        state.files = null;
        state.assignMessageId = null;
        state.assignBody = null;
        state.phaseBeforeStop = null;
        state.assigned = false;
        state.pendingQuestionId = null;
        state.discussRound = 0;
        state.discussLimit = null;
        state.lastProgressAt = null;
        state.workStartedAt = null;
        notes.push(
          `新議題「${m.title || '(未命名)'}」（id=${m.id}）。${topicRepoText(m.fields, room)}。${m.attachments?.length ? `議題附檔 ${m.attachments.length} 個，見訊息裡的 download 指令。` : ''}`,
        );
        break;
      case 'ASSIGN': {
        // 整組取代分工：這則沒寫的欄位一律清成 null，不沿用上一個分工。
        const branch = m.fields.branch || null;
        const iso = String(m.fields.isolation || '').toLowerCase();
        state.role = sanitizeRole(m.fields.role);
        state.task = m.fields.task || null;
        state.branch = branch;
        state.isolation = iso === 'worktree' || iso === 'shared' ? iso : branch ? 'worktree' : null;
        state.files = splitFiles(m.fields.files);
        state.assignMessageId = m.id;
        state.assignBody = m.body || null;
        state.assigned = true;
        state.phase = 'discussion';
        state.discussRound = 0;
        state.discussLimit = null;
        const parts = [`角色：${state.role || '(未指定)'}`];
        if (state.task) parts.push(`分工：${state.task}`);
        if (state.branch) parts.push(`分支：${state.branch}（${state.isolation}）`);
        else if (state.isolation) parts.push(`隔離：${state.isolation}`);
        if (state.files) parts.push(`可改檔案：${state.files.join(', ')}`);
        if (state.assignBody) parts.push('細節見這則 [ASSIGN] 的內文');
        // 同一個 branch 指派給多人時，worktree 模式下會互相衝突。只數像 agent 名稱的 @（英數字開頭、不是保留字），
        // `請和@前端協調` 這種提到角色的不算。
        const first = firstLineOf(m.content);
        const agentWords = new Set(
          extractMentions(first)
            .at.map((p) => (first.slice(p).match(/^[A-Za-z0-9][A-Za-z0-9_-]*/) || [''])[0].toLowerCase())
            .filter((w) => w && !RESERVED_NAMES.includes(w) && !BROADCAST.has(w)),
        );
        const many = targetsOf(m.content).broadcast || agentWords.size > 1;
        const clash = branch && many ? '這則指派給了多人且指定同一個 branch，worktree 模式會衝突，請先用 ask 向主導者確認。' : '';
        const badIso =
          iso && iso !== 'worktree' && iso !== 'shared'
            ? `isolation「${m.fields.isolation}」無效（只接受 worktree、shared），已當成沒寫${branch ? '，用預設的 worktree' : ''}；有疑問請 ask。`
            : '';
        notes.push(
          `你被指派（id=${m.id}）：${parts.join('；')}。${clash}${badIso}先用 ${cmdText(state.name, 'ack', '<你的理解>', room)} 回覆，再用 ${cmdText(state.name, 'discuss', '<內文>', room)} 討論（本段上限 ${roundLimit(state, room)} 則）。`,
        );
        break;
      }
      case 'GO':
        state.phase = 'work';
        state.workStartedAt = m.timestamp || new Date().toISOString();
        // 工作中的長步驟不算閒置（§5.4）。
        state.emptyWaitSince = null;
        notes.push(
          `主導者 [GO]（id=${m.id}）：討論結束，依你的分工開始執行；每完成一個里程碑用 ${cmdText(state.name, 'progress', '--percent <0-100> <內文>', room)} 回報（至少每 ${room.progressReminderMin} 分鐘一次），做完用 ${cmdText(state.name, 'done', '<摘要>', room)}。`,
        );
        break;
      case 'CONTINUE': {
        const n = parseInt((stripMentions(m.title).match(/\d+/) || [])[0], 10);
        state.discussLimit = Number.isFinite(n) && n > 0 ? n : null;
        state.discussRound = 0;
        state.phase = 'discussion';
        notes.push(`主導者 [CONTINUE]（id=${m.id}）：再開一段討論，本段上限 ${roundLimit(state, room)} 則。`);
        break;
      }
      case 'STOP':
        // 連續兩次 STOP 時保留第一次之前的階段，之後沒 @ 的 GO／CONTINUE 才判斷得對。
        if (state.phase !== 'stopped') state.phaseBeforeStop = state.phase;
        state.phase = 'stopped';
        notes.push(`主導者 [STOP]（id=${m.id}）：立刻停下手上的動作，只用 ${waitText(state.name, room, 'moderator')} 等指示。`);
        break;
      case 'CLOSE':
        state.phase = 'closed';
        notes.push(`主導者 [CLOSE]（id=${m.id}）：議題結束。請 ${cmdText(state.name, 'leave', '', room)}，然後結束任務並向使用者報告。`);
        break;
      case 'ANSWER':
        state.pendingQuestionId = null;
        notes.push(`主導者 [ANSWER]（id=${m.id}）回答了你，請依回答繼續。`);
        break;
      default:
        break;
    }
  }
  return notes;
}

// 依目前狀態產生提醒。
export function reminders(state, room, now = Date.now()) {
  const list = [];
  switch (state.phase) {
    case 'lobby':
      list.push(`目前沒有進行中的議題：用 ${waitText(state.name, room, 'moderator')} 等主導者發 [TOPIC]。`);
      break;
    case 'topic':
      list.push(`有議題但你還沒被指派：用 ${waitText(state.name, room, 'mention')} 等 [ASSIGN]。`);
      break;
    case 'discussion': {
      const limit = roundLimit(state, room);
      const atLimit = state.discussRound >= limit;
      list.push(
        `討論輪數：已發 ${state.discussRound}/${limit} 則 [DISCUSS]${atLimit ? `，已達上限，請 ${waitText(state.name, room, 'moderator')} 等 [CONTINUE] 或 [GO]` : ''}。`,
      );
      break;
    }
    case 'work': {
      // 從上次 [PROGRESS] 算起；還沒回報過就從 [GO] 的時間算起。
      const since = Date.parse(state.lastProgressAt || state.workStartedAt || state.joinedAt || '');
      if (Number.isFinite(since)) {
        const minutes = Math.floor((now - since) / 60000);
        if (minutes >= room.progressReminderMin) {
          list.push(`距上次 [PROGRESS] 已 ${minutes} 分鐘，請用 ${cmdText(state.name, 'progress', '--percent <0-100> <內文>', room)} 回報進度。`);
        }
      }
      break;
    }
    case 'done':
      list.push(`你已發出 [DONE]：用 ${waitText(state.name, room, 'moderator')} 等主導者的下一步。`);
      break;
    case 'stopped':
      list.push(`目前是 [STOP] 狀態：停下手上的動作，只用 ${waitText(state.name, room, 'moderator')} 等指示。`);
      break;
    case 'closed':
      list.push(`議題已 [CLOSE]：請 ${cmdText(state.name, 'leave', '', room)} 後結束任務並向使用者報告。`);
      break;
    case 'idle':
      list.push(`已發過 [IDLE]：頻道長時間無人回應，請 ${cmdText(state.name, 'leave', '', room)} 後結束任務並告知使用者。`);
      break;
    case 'left':
      list.push(`${LEFT_TEXT}。`);
      break;
    default:
      break;
  }
  if (state.pendingQuestionId && !['closed', 'idle', 'left'].includes(state.phase)) {
    list.push(`你的 [QUESTION]（id=${state.pendingQuestionId}）還沒得到回答：用 ${waitText(state.name, room, 'mention')} 等主導者。`);
  }
  return list;
}

// 指令在目前階段可不可以用；不行時回中文說明。
export function phaseError(state, command, room) {
  const phase = state.left ? 'left' : state.phase;
  const allowed = PHASE_COMMANDS[phase] ?? [];
  if (allowed.includes(command)) return null;
  const can = allowed.length ? `目前可用：${allowed.join('、')}` : LEFT_TEXT;
  const hint = phase === 'left' ? '' : reminders({ ...state, phase }, { ...room, progressReminderMin: Infinity })[0];
  return `目前階段是 ${phase}，不能用 ${command}。${can}。${hint || ''}`;
}
