// 指令共用的環境：房間設定、Discord client、agent 狀態、webhook，以及幾個常用的輸出片段。
import { requireAs } from './args.js';
import { getToken, loadRoom } from './config.js';
import { compareSnowflake, createClient } from './discord.js';
import { DiscordError, UserError } from './errors.js';
import { isSystemMessage, normalize, roundLimit, validateAgentName } from './protocol.js';
import { fmtSize } from './render.js';
import { clearWebhook, loadAgent, loadWebhook, saveWebhook } from './state.js';

export function createContext({ command, values, positionals, stdin }) {
  let room;
  let client;
  return {
    command,
    values,
    positionals,
    stdin,
    get room() {
      room ??= loadRoom(values.room);
      return room;
    },
    get client() {
      client ??= createClient(getToken());
      return client;
    },
  };
}

export function agentName(ctx) {
  const name = requireAs(ctx.values);
  const problem = validateAgentName(name);
  if (problem) throw new UserError(`--as ${name}：${problem}`);
  return name;
}

export function joinHint(name) {
  return `agentchat join --as ${name} --vendor <claude|gemini|codex|other>`;
}

// 還沒 join 的 agent 一律以結束碼 2 拒絕（§6.1）。
export function requireAgent(ctx) {
  const name = agentName(ctx);
  const state = loadAgent(ctx.room.channelId, name);
  if (!state) throw new UserError(`${name} 還沒進房：先執行 ${joinHint(name)}`);
  return state;
}

export function webhookIdOf(room) {
  return loadWebhook(room.channelId)?.id ?? null;
}

// 系統訊息（釘選、成員加入等）不是任何人的發言，不輸出也不參與判斷。
export function normalizeAll(raws, room, self) {
  const webhookId = webhookIdOf(room);
  return raws.filter((raw) => !isSystemMessage(raw)).map((raw) => normalize(raw, room, self, { webhookId }));
}

// 確保本房 webhook 可用（§6.3 doctor 第 8 項）：快取有效就用；否則找頻道裡同名且有 token 的；再沒有就建立。
// 多台機器同時建立時可能出現多個同名 webhook，一律挑 ID 最小的，讓各機器認定的「本房 webhook」一致。
export async function ensureWebhook(client, room, { verify = true } = {}) {
  const cached = loadWebhook(room.channelId);
  if (cached?.id && cached?.token) {
    if (!verify) return { webhook: cached, source: 'cache' };
    try {
      const info = await client.getWebhook(cached.id, cached.token);
      if (!info?.channel_id || info.channel_id === room.channelId) return { webhook: cached, source: 'cache' };
    } catch (e) {
      if (!(e instanceof DiscordError) || ![401, 403, 404].includes(e.status)) throw e;
    }
    clearWebhook(room.channelId);
  }
  const pick = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((w) => w.name === room.webhookName && w.token)
      .sort((a, b) => compareSnowflake(a.id, b.id))[0];
  let hook = pick(await client.listWebhooks(room.channelId));
  let source = 'found';
  if (!hook) {
    const created = await client.createWebhook(room.channelId, room.webhookName);
    hook = pick(await client.listWebhooks(room.channelId)) || created;
    source = 'created';
  }
  if (!hook?.id || !hook?.token) throw new DiscordError(0, null, '取得的 webhook 沒有 token，無法用來發言');
  const webhook = { id: hook.id, token: hook.token, channelId: room.channelId, name: hook.name ?? room.webhookName };
  saveWebhook(room.channelId, webhook);
  return { webhook, source };
}

export const WEBHOOK_SOURCE_TEXT = {
  cache: '本機快取有效',
  found: '找到頻道裡既有的 webhook',
  created: '已建立新的 webhook',
};

export const UNREAD_PAGES = 5;

// 游標之後、不是自己發的訊息則數。excludeIds 是剛送出的訊息（可能還來不及被認成 self）。
// 最多抓 UNREAD_PAGES 頁；抓滿時 capped 為 true，實際可能更多。
export async function countUnread(ctx, state, excludeIds = []) {
  if (!state.cursor) return { count: 0, capped: false };
  const raws = await ctx.client.messagesAfter(ctx.room.channelId, state.cursor, UNREAD_PAGES);
  const count = normalizeAll(raws, ctx.room, state).filter((m) => m.kind !== 'self' && !excludeIds.includes(m.id)).length;
  return { count, capped: raws.length >= UNREAD_PAGES * 100 };
}

export function unreadText(unread) {
  return `${unread.count}${unread.capped ? '+' : ''}`;
}

export function unreadLine(unread) {
  if (!unread || unread.count <= 0) return null;
  return `未讀：${unreadText(unread)} 則，先用 agentchat wait --timeout 0 讀取`;
}

export function roundInfo(state, room) {
  return { done: state.discussRound ?? 0, limit: roundLimit(state, room) };
}

export function phaseOf(state) {
  return state.left ? 'left' : state.phase;
}

// wait 的第二行（§6.3 固定格式，分隔是全形空白）；status、join 也用同一行。
export function summaryLine(state, room) {
  const r = roundInfo(state, room);
  return `階段：${phaseOf(state)}　角色：${state.role || '未指派'}　討論：${r.done}/${r.limit}`;
}

// status 與重新連線時印的狀態摘要。
export function stateLines(state, room) {
  const lines = [summaryLine(state, room)];
  if (state.task) lines.push(`分工：${state.task}`);
  if (state.branch) lines.push(`分支：${state.branch}（${state.isolation || 'worktree'}）`);
  else if (state.isolation) lines.push(`隔離：${state.isolation}`);
  if (state.files?.length) lines.push(`可改檔案：${state.files.join(', ')}`);
  if (state.assignBody) lines.push(`分工細節（[ASSIGN] id=${state.assignMessageId}）：`, state.assignBody);
  if (state.topic) {
    const f = state.topic.fields || {};
    const repo = f.repo || (room.defaultRepo ? `${room.defaultRepo}（房間預設）` : '未指定（有 branch 或 isolation 分工時用目前目錄所在的 git repo）');
    const rounds = f.rounds || `${room.maxDiscussionRounds}（房間預設）`;
    lines.push(`議題：「${state.topic.title || '(未命名)'}」（id=${state.topic.id}）`);
    lines.push(`議題欄位：repo：${repo}　base：${f.base || room.defaultBase}　rounds：${rounds}`);
    const files = state.topic.attachments || [];
    if (files.length) {
      lines.push(
        `議題附檔：${files.map((a) => `${a.filename}（${fmtSize(a.size)}）`).join('、')}→ agentchat download --as ${state.name} ${state.topic.id}`,
      );
    }
  } else {
    lines.push('議題：無');
  }
  lines.push(`游標：${state.cursor ?? '(無)'}`);
  lines.push(`待答問題：${state.pendingQuestionId ? `id=${state.pendingQuestionId}` : '無'}`);
  return lines;
}

export function publicState(state, room) {
  return {
    name: state.name,
    phase: phaseOf(state),
    role: state.role,
    task: state.task,
    branch: state.branch,
    isolation: state.isolation,
    files: state.files,
    assignMessageId: state.assignMessageId ?? null,
    assignBody: state.assignBody ?? null,
    topic: state.topic,
    round: roundInfo(state, room),
    cursor: state.cursor,
    pendingQuestionId: state.pendingQuestionId,
  };
}

// --json 輸出的訊息：附檔連結會過期，不放進去，要用 download 重新取得。
export function publicMessage(m) {
  return { ...m, attachments: m.attachments.map(({ url, ...rest }) => rest) };
}
