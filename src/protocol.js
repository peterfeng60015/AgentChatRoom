// 訊息協定：第一行 `[TAG] 標題`，接著零或多行 `key: value`，空一行後是內文。

export const MODERATOR_TAGS = ['TOPIC', 'ASSIGN', 'GO', 'CONTINUE', 'STOP', 'CLOSE', 'ANSWER'];
export const AGENT_TAGS = ['JOIN', 'LEAVE', 'ACK', 'DISCUSS', 'QUESTION', 'PROGRESS', 'DONE', 'IDLE', 'INFO'];
export const ALL_TAGS = [...MODERATOR_TAGS, ...AGENT_TAGS];

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
export const DISCORD_MESSAGE_LIMIT = 2000;

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

export function parseMessage(content = '') {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let tag = null;
  let title = '';
  let rest = lines;
  const m = (lines[0] ?? '').match(/^\s*\[([A-Za-z]+)\]\s*(.*)$/);
  if (m) {
    tag = m[1].toUpperCase();
    title = m[2].trim();
    rest = lines.slice(1);
  }
  const fields = {};
  let i = 0;
  // 欄位列必須緊接在標籤列之後，遇到第一個非欄位列（含空白列）就停。
  while (i < rest.length) {
    const fm = rest[i].match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!fm) break;
    fields[fm[1].toLowerCase()] = (fm[2] ?? '').trim();
    i++;
  }
  const body = rest.slice(i).join('\n').trim();
  return { tag, title, fields, body };
}

export function buildMessage(tag, title = '', fields = {}, body = '') {
  const lines = [`[${tag}]${title ? ' ' + title : ''}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${value}`);
  }
  if (body) lines.push('', body);
  return lines.join('\n');
}

export function extractMentions(content = '') {
  const users = [...content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
  const stripped = content.replace(/<@!?\d+>/g, ' ');
  const names = [...stripped.matchAll(/(?:^|[\s(（,，、:：])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)].map((m) =>
    m[1].toLowerCase().replace(/[.]+$/, ''),
  );
  return { users, names };
}

const BROADCAST = new Set(['all', 'agents', 'everyone', 'here']);

export function isMentioned(content, { name, role }) {
  const { names } = extractMentions(content);
  const n = String(name).toLowerCase();
  const r = role ? String(role).toLowerCase() : null;
  return names.some((x) => x === n || BROADCAST.has(x) || (r && x === r));
}

export function displayName(name, role) {
  return role ? `${name} (${role})` : name;
}

export function splitAgentName(username = '') {
  const m = username.match(/^(.*?)(?: \((.*)\))?$/);
  return { name: m ? m[1] : username, role: m && m[2] ? m[2] : null };
}

export function isSelfName(username = '', name) {
  return username === name || username.startsWith(`${name} (`);
}

export function sanitizeRole(role) {
  if (!role) return null;
  return String(role).replace(/[()（）\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
}

// 判斷訊息作者身分：moderator / self / agent / bot / human
export function authorKind(msg, room, self) {
  if (msg.author?.id === room.moderatorUserId) return 'moderator';
  if (msg.webhook_id) {
    if (self && isSelfName(msg.author?.username, self.name)) return 'self';
    return 'agent';
  }
  if (msg.author?.bot) return 'bot';
  return 'human';
}

// 把 Discord 原始訊息整理成工具內部統一格式。
export function normalize(msg, room, self) {
  const kind = authorKind(msg, room, self);
  const content = msg.content || '';
  const parsed = parseMessage(content);
  let author;
  let authorRole = null;
  if (kind === 'agent' || kind === 'self') {
    ({ name: author, role: authorRole } = splitAgentName(msg.author?.username));
  } else {
    author = msg.author?.global_name || msg.author?.username || '(未知)';
  }
  return {
    id: msg.id,
    timestamp: msg.timestamp,
    kind,
    author,
    authorRole,
    authorId: msg.author?.id ?? null,
    content,
    tag: parsed.tag,
    title: parsed.title,
    fields: parsed.fields,
    body: parsed.body,
    mentionsMe: self ? isMentioned(content, self) : false,
    mentionsModerator: (msg.mentions || []).some((u) => u.id === room.moderatorUserId),
    attachments: (msg.attachments || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      url: a.url,
      contentType: a.content_type || null,
    })),
  };
}

// 把超過 Discord 上限的訊息切段，盡量在行邊界切，並維持 code fence 成對。
export function splitMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];
  const effective = limit - 12; // 預留 "(n/m)" 標記
  const chunks = [];
  let current = '';
  let inFence = false;
  let fenceLine = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.replace(/\n+$/, ''));
    current = '';
  };

  for (const line of text.split('\n')) {
    const isFence = /^\s*```/.test(line);
    let candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > effective) {
      if (inFence) current += '\n```';
      flush();
      current = inFence ? fenceLine : '';
      candidate = current ? `${current}\n${line}` : line;
      while (candidate.length > effective) {
        chunks.push(candidate.slice(0, effective));
        candidate = candidate.slice(effective);
      }
    }
    current = candidate;
    if (isFence) {
      inFence = !inFence;
      fenceLine = inFence ? line.trim() : '';
    }
  }
  flush();
  return chunks.map((c, i) => `${c}\n(${i + 1}/${chunks.length})`);
}

// 依主導者的指令更新 agent 狀態，回傳給 agent 看的「注意」事項。
export function applyDirectives(state, messages, room) {
  const notes = [];
  for (const m of messages) {
    if (m.kind === 'self') continue;
    state.lastActivityAt = m.timestamp;
    if (m.kind !== 'moderator') continue;
    switch (m.tag) {
      case 'TOPIC':
        state.topic = { id: m.id, title: m.title, fields: m.fields, body: m.body };
        state.phase = 'topic';
        state.discussRound = 0;
        state.discussLimit = null;
        state.role = null;
        state.branch = null;
        state.isolation = null;
        state.task = null;
        state.lastProgressAt = null;
        state.workStartedAt = null;
        notes.push(
          `新議題「${m.title}」${m.fields.repo ? `（作業 repo: ${m.fields.repo}）` : '（純討論，沒有作業 repo）'}。請 wait --until moderator 等 [ASSIGN]。`,
        );
        break;
      case 'ASSIGN':
        if (m.mentionsMe) {
          state.role = sanitizeRole(m.fields.role) || state.role;
          state.branch = m.fields.branch || null;
          state.isolation = m.fields.isolation || (m.fields.branch ? 'worktree' : null);
          state.task = m.fields.task || m.body || m.title.replace(/^@\S+\s*/, '') || null;
          state.phase = 'discussion';
          state.discussRound = 0;
          notes.push(
            `你被指派：role=${state.role || '(未指定)'}${state.branch ? `，branch=${state.branch}，isolation=${state.isolation}` : ''}${state.task ? `，task=${state.task}` : ''}。請先 agentchat ack 回覆理解，再開始 [DISCUSS]。`,
          );
        }
        break;
      case 'GO':
        state.phase = 'work';
        state.workStartedAt = m.timestamp;
        notes.push('主導者 [GO]：討論結束，依你的分工開始執行，完成里程碑就 agentchat progress。');
        break;
      case 'CONTINUE': {
        const n = parseInt(m.title, 10);
        state.discussLimit = Number.isFinite(n) && n > 0 ? n : room.maxDiscussionRounds;
        state.discussRound = 0;
        state.phase = 'discussion';
        notes.push(`主導者 [CONTINUE]：再開 ${state.discussLimit} 輪討論。`);
        break;
      }
      case 'STOP':
        state.phase = 'stopped';
        notes.push('主導者 [STOP]：立刻停止目前動作，只做 wait --until moderator 等指示。');
        break;
      case 'CLOSE':
        state.phase = 'closed';
        notes.push('主導者 [CLOSE]：議題結束，請 agentchat leave，然後結束任務並向使用者報告。');
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
  if (state.phase === 'work') {
    const since = state.lastProgressAt || state.workStartedAt || state.joinedAt;
    const minutes = Math.floor((now - Date.parse(since)) / 60000);
    if (minutes >= room.progressReminderMin) {
      list.push(`距上次 [PROGRESS] 已 ${minutes} 分鐘，請用 agentchat progress 回報進度。`);
    }
  }
  if (state.phase === 'discussion') {
    const limit = state.discussLimit ?? room.maxDiscussionRounds;
    const atLimit = state.discussRound >= limit;
    list.push(
      `討論輪數：已發 ${state.discussRound}/${limit} 則 [DISCUSS]${atLimit ? '，已達上限，請 wait --until moderator 等 [CONTINUE] 或 [GO]' : ''}。`,
    );
  }
  if (state.phase === 'topic') list.push('有議題但你尚未被指派，請 wait --until moderator 等 [ASSIGN]。');
  if (state.phase === 'stopped') list.push('目前是 [STOP] 狀態：只做 wait --until moderator。');
  if (state.phase === 'closed') list.push('議題已 [CLOSE]：請 agentchat leave 後結束。');
  if (state.phase === 'idle') list.push('已發過 [IDLE]：頻道長時間無人回應，請結束任務並告知使用者。');
  return list;
}
