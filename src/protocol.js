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

// §4.4 的 mention：@ 前面是行首或不是 email 帳號字元（中文緊接也算）。
// @ 後第一個字是英數字或底線時，token 是最長的 [A-Za-z0-9_-]；否則取到下一個空白或標點為止。
const MENTION_RE = /(?<![A-Za-z0-9_.+-])[@＠](?:([A-Za-z0-9_][A-Za-z0-9_-]*)|([^\s\p{P}]+))/gu;
const DISCORD_USER_RE = /<@!?(\d+)>/g;
const MODERATOR_ALIASES = new Set(['moderator', '主導者']);

export function validateAgentName(name) {
  if (!name || !NAME_RE.test(name)) {
    return '名稱只能用英數字、底線、連字號，開頭須為英數字，長度 1 到 31，例如 claude-1';
  }
  const lower = name.toLowerCase();
  if (lower.includes('discord') || lower.includes('clyde')) {
    return 'Discord 不允許名稱含有 discord 或 clyde';
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

export function extractMentions(content = '') {
  const text = String(content ?? '');
  const users = [...text.matchAll(DISCORD_USER_RE)].map((m) => m[1]);
  const stripped = text.replace(DISCORD_USER_RE, ' ');
  const names = [...stripped.matchAll(MENTION_RE)].map((m) => (m[1] ?? m[2]).toLowerCase());
  return { users, names };
}

export function isBroadcastName(name) {
  return BROADCAST.has(String(name).toLowerCase());
}

export function isMentioned(content, self) {
  if (!self || !self.name) return false;
  const { names } = extractMentions(content);
  const n = String(self.name).toLowerCase();
  const r = self.role ? String(self.role).toLowerCase() : null;
  return names.some((x) => x === n || BROADCAST.has(x) || (r !== null && x === r));
}

// 指令的作用對象只看第一行。names 不含廣播字。
export function targetsOf(content = '') {
  const firstLine = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')[0];
  const { names } = extractMentions(firstLine);
  const broadcast = names.some((x) => BROADCAST.has(x));
  return { names: [...new Set(names.filter((x) => !BROADCAST.has(x)))], broadcast };
}

// 被回覆的訊息是不是我發的：最近的 ownMessageIds，加上待答問題（掉出最近 50 則也認得）。
export function isReplyToMe(replyTo, self) {
  if (!replyTo || !self) return false;
  return (self.ownMessageIds || []).includes(replyTo) || self.pendingQuestionId === replyTo;
}

// §4.4「指令對我生效」。只有主導者的指令算數，所以帶了 kind 且不是 moderator 一律不生效。
// self 是 agent 狀態：沒 @ 的 [GO]／[CONTINUE]／[STOP] 要看 assigned、phase 與 phaseBeforeStop。
// 「有 @」只算 agent 式的 @ token；Discord 選單產生的 <@使用者ID> 不算（targetsOf 已排除）。
export function isTargeted(msg, self) {
  if (!msg || !self || !self.name) return false;
  if (msg.kind && msg.kind !== 'moderator') return false;
  const tag = msg.tag;
  if (!tag) return false;
  const content = msg.content ?? `[${tag}]${msg.title ? ' ' + msg.title : ''}`;
  const { names, broadcast } = targetsOf(content);
  const name = String(self.name).toLowerCase();
  const role = self.role ? String(self.role).toLowerCase() : null;
  const phase = self.left ? 'left' : self.phase;
  const named = broadcast || names.includes(name);
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
      if (broadcast || names.length) {
        if (phase === 'left') return false;
        return named || (role !== null && names.includes(role));
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

// 主導者別名用和其他 mention 一樣的 token 規則：`請@主導者 看` 會換，`@主導者請看` 的 token 是「主導者請看」不換。
export function resolveMentions(text, room) {
  return String(text ?? '').replace(MENTION_RE, (whole, ascii, other) =>
    MODERATOR_ALIASES.has((ascii ?? other).toLowerCase()) ? `<@${room.moderatorUserId}>` : whole,
  );
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

export function isSelfName(username = '', name) {
  if (!name) return false;
  const u = String(username ?? '');
  return u === name || u.startsWith(`${name} (`);
}

// 角色會出現在 webhook 顯示名稱 `名稱 (角色)` 與 @角色 裡：刪掉會破壞格式或觸發 mention 的字元，
// 空白換成 -，讓角色一定能用 @角色 提到。
export function sanitizeRole(role) {
  if (role === undefined || role === null) return null;
  const cleaned = String(role)
    .replace(/[()（）[\]［］【】{}｛｝<>＜＞@＠#:：`]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
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

function replyIdOf(raw) {
  const ref = raw?.message_reference;
  if (!ref || !ref.message_id) return null;
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

// 把超過 Discord 上限的訊息切段：盡量在行邊界切，code fence 跨段時兩邊補成對，每段結尾加 (i/n)。
export function splitMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const source = String(text ?? '');
  if (source.length <= limit) return [source];
  const FENCE_CLOSE = '\n```';
  const MARK_RESERVE = 12; // "\n(9999/9999)" 的長度
  const budget = Math.max(8, limit - MARK_RESERVE - FENCE_CLOSE.length);
  const chunks = [];
  let current = null; // 目前這段的行
  let fenceOpen = null; // 目前所在 code fence 的開頭行，例如 ```js

  const size = (lines, extra) => (lines.length ? lines.join('\n').length + 1 : 0) + extra.length;
  const flush = () => {
    let close = Boolean(fenceOpen);
    // fence 剛好在這段最後一行打開、還沒有內容：把開頭行留給下一段，不留下空的區塊。
    if (current && fenceOpen && current.length > 1 && /^\s*```/.test(current[current.length - 1])) {
      current.pop();
      close = false;
    }
    if (current && current.length > (close ? 1 : 0) && current.some((l) => l.trim() !== '')) {
      const body = current.join('\n').replace(/\n+$/, '');
      chunks.push(close ? body + FENCE_CLOSE : body);
    }
    current = null;
  };
  const push = (line) => {
    if (current && size(current, line) > budget && current.length > (fenceOpen ? 1 : 0)) flush();
    if (!current) current = fenceOpen ? [fenceOpen] : [];
    current.push(line);
  };

  for (const line of source.split('\n')) {
    const isFence = /^\s*```/.test(line);
    if (isFence && fenceOpen) {
      // 收尾的 fence：放得下就放進這段；放不下就直接收段（flush 會補 ```），不在下一段開一個空區塊。
      if (current && size(current, line) <= budget + FENCE_CLOSE.length) current.push(line);
      else flush();
      fenceOpen = null;
      continue;
    }
    const room = Math.max(1, budget - (fenceOpen ? fenceOpen.length + 1 : 0));
    if (line.length <= room) {
      push(line);
    } else {
      // 單行就超過上限：硬切，但不切開代理對。
      let rest = [...line];
      while (rest.length) {
        let piece = '';
        let count = 0;
        while (count < rest.length && piece.length + rest[count].length <= room) piece += rest[count++];
        if (count === 0) piece = rest[count++];
        rest = rest.slice(count);
        push(piece);
      }
    }
    if (isFence) fenceOpen = line.trim();
  }
  flush();
  if (chunks.length <= 1) return chunks.length ? chunks : [source.slice(0, limit)];
  return chunks.map((c, i) => `${c}\n(${i + 1}/${chunks.length})`);
}

// 本段討論的則數上限：CONTINUE n > 議題的 rounds > 房間預設。
export function roundLimit(state, room) {
  if (Number.isInteger(state.discussLimit) && state.discussLimit > 0) return state.discussLimit;
  const fromTopic = parseInt(state.topic?.fields?.rounds, 10);
  if (Number.isFinite(fromTopic) && fromTopic > 0) return fromTopic;
  return room.maxDiscussionRounds;
}

// §5.5 作業 repo 的來源：[TOPIC] 的 repo > room.defaultRepo > 目前工作目錄。只有分工帶 branch 或 isolation 時才用得到。
export function topicRepoText(fields = {}, room) {
  let repo;
  if (fields.repo) repo = `${fields.repo}（[TOPIC] 指定）`;
  else if (room.defaultRepo) repo = `${room.defaultRepo}（房間預設）`;
  else repo = '未指定，有 branch 分工時用目前目錄';
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

// [CONTINUE] 的 n 要先去掉 @ token 與 <@ID>，免得抓到 claude-1 的 1。
function stripMentions(text) {
  return String(text ?? '')
    .replace(DISCORD_USER_RE, ' ')
    .replace(MENTION_RE, ' ')
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
    // §5.4：別的 agent 進出房與 [IDLE] 不算有人回應，不重設無人回應的計時。
    const presence = (m.kind === 'agent' || m.kind === 'bot') && PRESENCE_TAGS.has(m.tag);
    if (!presence) state.emptyWaitSince = null;
    if (m.kind !== 'moderator') continue;

    // §4.4：主導者用 Discord 回覆我的任何一則訊息，或不加標籤直接 @ 我的名稱，都視為回答了待答問題。
    if (state.pendingQuestionId && m.tag !== 'ANSWER') {
      const byReply = isReplyToMe(m.replyTo, state);
      const byName = !m.tag && extractMentions(m.content).names.includes(String(state.name).toLowerCase());
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
        notes.push(
          `你被指派（id=${m.id}）：${parts.join('；')}。先用 agentchat ack 回覆你的理解，再用 agentchat discuss 討論（本段上限 ${roundLimit(state, room)} 則）。`,
        );
        break;
      }
      case 'GO':
        state.phase = 'work';
        state.workStartedAt = m.timestamp || new Date().toISOString();
        // 工作中的長步驟不算閒置（§5.4）。
        state.emptyWaitSince = null;
        notes.push(
          `主導者 [GO]（id=${m.id}）：討論結束，依你的分工開始執行；每完成一個里程碑用 agentchat progress 回報（至少每 ${room.progressReminderMin} 分鐘一次），做完用 agentchat done。`,
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
        notes.push(`主導者 [STOP]（id=${m.id}）：立刻停下手上的動作，只用 agentchat wait --until moderator 等指示。`);
        break;
      case 'CLOSE':
        state.phase = 'closed';
        notes.push(`主導者 [CLOSE]（id=${m.id}）：議題結束。請 agentchat leave，然後結束任務並向使用者報告。`);
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
      list.push('目前沒有進行中的議題：用 agentchat wait --until moderator 等主導者發 [TOPIC]。');
      break;
    case 'topic':
      list.push('有議題但你還沒被指派：用 agentchat wait --until mention 等 [ASSIGN]。');
      break;
    case 'discussion': {
      const limit = roundLimit(state, room);
      const atLimit = state.discussRound >= limit;
      list.push(
        `討論輪數：已發 ${state.discussRound}/${limit} 則 [DISCUSS]${atLimit ? '，已達上限，請 agentchat wait --until moderator 等 [CONTINUE] 或 [GO]' : ''}。`,
      );
      break;
    }
    case 'work': {
      const times = [state.lastProgressAt, state.workStartedAt, state.joinedAt]
        .map((x) => (x ? Date.parse(x) : NaN))
        .filter(Number.isFinite);
      if (times.length) {
        const minutes = Math.floor((now - Math.max(...times)) / 60000);
        if (minutes >= room.progressReminderMin) {
          list.push(`距上次 [PROGRESS] 已 ${minutes} 分鐘，請用 agentchat progress 回報進度。`);
        }
      }
      break;
    }
    case 'done':
      list.push('你已發出 [DONE]：用 agentchat wait --until moderator 等主導者的下一步。');
      break;
    case 'stopped':
      list.push('目前是 [STOP] 狀態：停下手上的動作，只用 agentchat wait --until moderator 等指示。');
      break;
    case 'closed':
      list.push('議題已 [CLOSE]：請 agentchat leave 後結束任務並向使用者報告。');
      break;
    case 'idle':
      list.push('已發過 [IDLE]：頻道長時間無人回應，請 agentchat leave 後結束任務並告知使用者。');
      break;
    case 'left':
      list.push(`${LEFT_TEXT}。`);
      break;
    default:
      break;
  }
  if (state.pendingQuestionId && !['closed', 'idle', 'left'].includes(state.phase)) {
    list.push(`你的 [QUESTION]（id=${state.pendingQuestionId}）還沒得到回答：用 agentchat wait --until mention 等主導者。`);
  }
  return list;
}

// 指令在目前階段可不可以用；不行時回中文說明。
export function phaseError(state, command, room) {
  const phase = state.left ? 'left' : state.phase;
  const allowed = PHASE_COMMANDS[phase] ?? [];
  if (allowed.includes(command)) return null;
  const can = allowed.length ? `目前可用：${allowed.join('、')}` : LEFT_TEXT;
  const hint = reminders({ ...state, phase }, { ...room, progressReminderMin: Infinity })[0];
  return `目前階段是 ${phase}，不能用 ${command}。${can}。${hint || ''}`;
}
