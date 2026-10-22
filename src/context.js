// 指令共用的環境：房間設定、Discord client、agent 狀態、webhook，以及幾個常用的輸出片段。
import { requireAs } from './args.js';
import { getToken, loadRoom } from './config.js';
import { compareSnowflake, createClient } from './discord.js';
import { DiscordError, UserError } from './errors.js';
import { cmdText, isSystemMessage, normalize, roundLimit, validateAgentName } from './protocol.js';
import { fmtSize, oneLine } from './render.js';
import {
  clearWebhook,
  listAgentWebhooks,
  loadAgent,
  loadKnownWebhooks,
  loadWebhook,
  missingAgentError,
  saveKnownWebhooks,
  saveWebhook,
} from './state.js';

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

export function joinHint(name, room) {
  return cmdText(name, 'join', '--vendor <claude|gemini|codex|other>', room);
}

// 還沒 join 的 agent 一律以結束碼 2 拒絕（§6.1）。
export function requireAgent(ctx) {
  const name = agentName(ctx);
  const state = loadAgent(ctx.room.channelId, name);
  if (!state) throw missingAgentError(ctx.room.channelId, name, `${name} 還沒進房：先執行 ${joinHint(name, ctx.room)}`);
  return state;
}

// 本工具的 webhook：共用的名稱等於 webhookName，專屬的是 `<webhookName>-<名稱小寫>`（§1）。
export function isRoomWebhookName(name, room) {
  return name === room.webhookName || (typeof name === 'string' && name.startsWith(`${room.webhookName}-`));
}

export function agentWebhookName(room, name) {
  return `${room.webhookName}-${String(name).toLowerCase()}`;
}

// 把查到的 ID 合併進辨識快取。寫入前重讀一次，免得蓋掉別的行程剛寫進去的；room 優先，同一個 ID 不會同時在 other。
function mergeKnownWebhooks(channelId, roomIds, otherIds = []) {
  const known = loadKnownWebhooks(channelId);
  const roomSet = new Set([...known.room, ...roomIds]);
  const other = [...known.other, ...otherIds].filter((id) => !roomSet.has(id));
  saveKnownWebhooks(channelId, { room: [...roomSet], other });
}

// 本機快取的本房 webhook 失效（被刪或 token 不對）而要刪快取時呼叫：先把它的 ID 記進辨識快取的 room，
// 它以前發的訊息（包括切段發言已經送出的段）才不會在快取刪掉後被當成陌生 webhook（bot）。寫不進去不影響發言。
export function rememberRoomWebhook(channelId, id) {
  if (!id) return;
  try {
    mergeKnownWebhooks(channelId, [id]);
  } catch {
    // 辨識快取寫不進去：最多是那些舊訊息之後被歸為 bot（§4.5 已知限制）。
  }
}

// §4.5 本房 webhook 的 ID 集合：共用 webhook、本機各 agent 的專屬 webhook、辨識快取的 room；
// 這批訊息裡有不認得的 webhook ID 時查一次頻道的 webhook 清單（同一個 ID 每個行程只查一次）。
// 查到的結果另外記在 ctx 上：辨識快取寫不進去時，同一個行程之後的輪詢也照這次的結果判斷，不會把查到的本房 ID 當成 bot。
// 回傳 null 表示一個本房 ID 都不知道（本機沒有快取，又查不到或頻道裡沒有本工具的 webhook），呼叫端照舊規則把所有 webhook 訊息都算本房。
export async function roomWebhookIds(ctx, raws) {
  const room = ctx.room;
  ctx.webhookLookup ??= { looked: new Set(), room: new Set(), other: new Set() };
  const memo = ctx.webhookLookup;
  const known = loadKnownWebhooks(room.channelId);
  const shared = loadWebhook(room.channelId)?.id ?? null;
  const ids = new Set([...known.room, ...memo.room]);
  if (shared) ids.add(shared);
  for (const hook of listAgentWebhooks(room.channelId)) ids.add(hook.id);
  const other = new Set([...known.other, ...memo.other]);
  const unknown = [...new Set((raws || []).map((r) => r?.webhook_id).filter(Boolean))].filter(
    (id) => !ids.has(id) && !other.has(id) && !memo.looked.has(id),
  );
  if (unknown.length) {
    for (const id of unknown) memo.looked.add(id);
    let list = null;
    try {
      list = await ctx.client.listWebhooks(room.channelId);
    } catch {
      // 查不到（例如沒有管理 Webhook 權限）就只用已知的，也不寫快取。
    }
    if (Array.isArray(list)) {
      const found = list.filter((w) => w?.id && isRoomWebhookName(w.name, room)).map((w) => String(w.id));
      for (const id of found) {
        ids.add(id);
        memo.room.add(id);
      }
      const strangers = unknown.filter((id) => !ids.has(id));
      for (const id of strangers) memo.other.add(id);
      try {
        mergeKnownWebhooks(room.channelId, found, strangers);
      } catch {
        // 快取寫不進去不影響判斷：這個行程用 ctx 上的結果，下一個行程再查。
      }
    }
  }
  return ids.size ? ids : null;
}

// 系統訊息（釘選、成員加入等）不是任何人的發言，不輸出也不參與判斷。
export async function normalizeAll(ctx, raws, self) {
  const webhookIds = await roomWebhookIds(ctx, raws);
  return raws.filter((raw) => !isSystemMessage(raw)).map((raw) => normalize(raw, ctx.room, self, { webhookIds }));
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
      // 失效的是本房以前的共用 webhook：記住它的 ID，它發過的訊息仍算本房（§4.5）。屬於別的頻道的就不記。
      rememberRoomWebhook(room.channelId, cached.id);
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
  const count = (await normalizeAll(ctx, raws, state)).filter((m) => m.kind !== 'self' && !excludeIds.includes(m.id)).length;
  return { count, capped: raws.length >= UNREAD_PAGES * 100 };
}

export function unreadText(unread) {
  return `${unread.count}${unread.capped ? '+' : ''}`;
}

export function unreadLine(unread, name, room) {
  if (!unread || unread.count <= 0) return null;
  return `未讀：${unreadText(unread)} 則，先用 ${cmdText(name, 'wait', '--timeout 0', room)} 讀取`;
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
        `議題附檔：${files.map((a) => `${oneLine(a.filename)}（${fmtSize(a.size)}）`).join('、')}→ ${cmdText(state.name, 'download', state.topic.id, room)}`,
      );
    }
  } else {
    lines.push('議題：無');
  }
  lines.push(`游標：${state.cursor ?? '(無)'}`);
  lines.push(`待答問題：${state.pendingQuestionId ? `id=${state.pendingQuestionId}` : '無'}`);
  return lines;
}

// status 額外印的實際生效設定（§6.3 status）：語言、作業 repo（§5.5 的順序）與 base。
export function effectiveLines(state, room) {
  const f = state.topic?.fields || {};
  const repo = f.repo || room.defaultRepo || '未指定，分工有 branch 或 isolation 時用目前目錄的 git repo';
  return [`語言：${room.language}`, `作業 repo：${repo}`, `base：${f.base || room.defaultBase}`];
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
