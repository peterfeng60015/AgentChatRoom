import { snowflakeNow } from '../discord.js';
import { ProtocolError, UserError } from '../errors.js';
import { applyDirectives, buildMessage, isTargeted, reminders, splitAgentName } from '../protocol.js';
import { renderMessage, section } from '../render.js';
import { appendLog, loadAgent, newAgent, recordOwnMessages, saveAgent } from '../state.js';
import {
  agentName,
  ensureWebhook,
  fetchUnread,
  normalizeAll,
  publicMessage,
  publicState,
  stateLines,
  unreadLine,
} from '../context.js';
import { sendParts } from '../publish.js';

export const summary = '進房：建立本機狀態、套用進行中的議題與指派，發 [JOIN]';
export const usage = 'agentchat join --as <名稱> --vendor <claude|gemini|codex|other> [--model <文字>] [--host <標籤>] [--force]';
export const options = {
  vendor: { type: 'string' },
  model: { type: 'string' },
  host: { type: 'string' },
  force: { type: 'boolean', default: false },
};
export const details = [
  '名稱：英數字、底線、連字號，英數字開頭，1 到 31 字元，慣例是 <vendor>-<編號>，例如 claude-1。',
  '本機已有狀態檔（且沒 leave）時視為重新連線：保留角色、階段與游標，不重發 [JOIN]。',
  '名稱在 24 小時內被別人用過（最後一則不是 [LEAVE] 或 [IDLE]）會拒絕，換名稱或加 --force。',
];

const VENDORS = ['claude', 'gemini', 'codex', 'other'];
const RECENT_LIMIT = 200;
const CONFLICT_WINDOW_MS = 24 * 60 * 60 * 1000;

function oneLine(value) {
  return value === undefined ? undefined : String(value).replace(/\s+/g, ' ').trim();
}

// 頻道最近 200 則，由舊到新。
async function fetchRecent(client, channelId) {
  const newest = await client.messages(channelId, { limit: 100 });
  if (newest.length < 100) return newest;
  const older = await client.messages(channelId, { before: newest[0].id, limit: RECENT_LIMIT - 100 });
  return [...older, ...newest];
}

// 主導者最後一則 [TOPIC] 之後沒有主導者的 [CLOSE]，就是進行中的議題。
function findActiveTopic(messages) {
  let index = -1;
  messages.forEach((m, i) => {
    if (m.kind !== 'moderator') return;
    if (m.tag === 'TOPIC') index = i;
    else if (m.tag === 'CLOSE') index = -1;
  });
  return index < 0 ? null : { topic: messages[index], after: messages.slice(index + 1) };
}

function findConflict(raws, room, name, webhookId, now) {
  const lower = name.toLowerCase();
  for (let i = raws.length - 1; i >= 0; i--) {
    const raw = raws[i];
    if (!raw.webhook_id || (webhookId && raw.webhook_id !== webhookId)) continue;
    if (splitAgentName(raw.author?.username).name.toLowerCase() !== lower) continue;
    const [m] = normalizeAll([raw], room, null);
    const age = now - Date.parse(raw.timestamp);
    if (age < CONFLICT_WINDOW_MS && m.tag !== 'LEAVE' && m.tag !== 'IDLE') return m;
    return null;
  }
  return null;
}

export async function run(ctx) {
  const name = agentName(ctx);
  const vendor = ctx.values.vendor;
  if (!vendor || !VENDORS.includes(vendor)) {
    throw new UserError(`--vendor 必須是 ${VENDORS.join('、')} 其中之一`);
  }
  const room = ctx.room;
  const client = ctx.client;
  const existing = loadAgent(room.channelId, name);

  if (existing && !existing.left) {
    let unread = null;
    let unreadError = null;
    try {
      unread = (await fetchUnread(ctx, existing)).length;
    } catch (e) {
      unreadError = e.message;
    }
    const rem = reminders(existing, room);
    const text = [
      `重新連線：${name} 已在房間 ${room.roomName}（頻道 ${room.channelId}），保留原本的狀態，沒有重發 [JOIN]。`,
      ...stateLines(existing, room),
    ];
    const u = unreadLine(unread ?? 0);
    if (u) text.push(u);
    if (unreadError) text.push(`未讀：無法取得（${unreadError}）`);
    const tail = section('下一步', rem);
    if (tail) text.push(tail);
    return {
      text,
      data: { reconnected: true, room: { name: room.roomName, channelId: room.channelId }, state: publicState(existing, room), unread, reminders: rem },
    };
  }

  const { webhook } = await ensureWebhook(client, room, { verify: true });
  const raws = await fetchRecent(client, room.channelId);
  const now = Date.now();

  // 只有本機沒有這個名稱的狀態檔時才檢查衝突；有狀態檔（已 leave）代表是自己重新進房。
  if (!existing && !ctx.values.force) {
    const clash = findConflict(raws, room, name, webhook.id, now);
    if (clash) {
      throw new ProtocolError(
        `名稱 ${name} 在 24 小時內有人用過（最後一則 id=${clash.id}，不是 [LEAVE] 或 [IDLE]）。請換一個名稱，或確定是同一個 agent 時加 --force。`,
      );
    }
  }

  const latest = raws.length ? raws[raws.length - 1].id : snowflakeNow();
  const state = newAgent({
    name,
    vendor,
    model: oneLine(ctx.values.model) || null,
    channelId: room.channelId,
    cursor: latest,
  });

  const messages = normalizeAll(raws, room, state);
  const active = findActiveTopic(messages);
  let notes = [];
  const assigns = [];
  if (active) {
    const topicNotes = applyDirectives(state, [active.topic], room);
    const assignNotes = [];
    // 依序套用議題之後對我生效的 [ASSIGN]；判斷用套用當下的狀態。
    for (const m of active.after) {
      if (m.kind === 'moderator' && m.tag === 'ASSIGN' && isTargeted(m, state)) {
        assigns.push(m);
        assignNotes.push(...applyDirectives(state, [m], room));
      }
    }
    // 已被指派時，「等 [ASSIGN]」的議題提示就不適用了。
    notes = assigns.length ? assignNotes : topicNotes;
  }

  const fields = { vendor, model: oneLine(ctx.values.model), host: oneLine(ctx.values.host) };
  const content = buildMessage('JOIN', name, fields);
  const ids = await sendParts(ctx, state, [content]);
  recordOwnMessages(state, ids);
  saveAgent(state);
  appendLog(room.channelId, { dir: 'out', agent: name, tag: 'JOIN', ids, content });

  const rem = reminders(state, room);
  const text = [
    `已進房：${name} → 房間 ${room.roomName}（頻道 ${room.channelId}），已送出 [JOIN]（id=${ids[0]}）。`,
    ...stateLines(state, room),
  ];
  if (active) {
    text.push('', '進行中的議題：', renderMessage(active.topic));
    if (assigns.length) text.push('', '對你生效的 [ASSIGN]：', ...assigns.map(renderMessage));
  }
  const n = section('注意', notes);
  if (n) text.push(n);
  const tail = section('下一步', rem);
  if (tail) text.push(tail);
  return {
    text,
    data: {
      reconnected: false,
      id: ids[0],
      room: { name: room.roomName, channelId: room.channelId },
      state: publicState(state, room),
      topic: active ? publicMessage(active.topic) : null,
      assigns: assigns.map(publicMessage),
      notes,
      reminders: rem,
    },
  };
}
