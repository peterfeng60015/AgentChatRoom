import { DiscordError, ProtocolError, UserError } from '../errors.js';
import { buildStatus } from './status.js';
import { applyEach, buildMessage, doctorText, reminders, splitAgentName } from '../protocol.js';
import { fmtTime, renderMessage, renderMessages, section } from '../render.js';
import { appendLog, loadAgent, newAgent, recordOwnMessages, saveAgent } from '../state.js';
import {
  agentName,
  ensureWebhook,
  normalizeAll,
  publicMessage,
  publicState,
  stateLines,
} from '../context.js';
import { guardSecrets, sendParts } from '../publish.js';

export const summary = '進房：建立本機狀態、套用進行中的議題與指派，發 [JOIN]';
export const usage =
  'agentchat join --as <名稱> --vendor <claude|gemini|codex|other> [--model <文字>] [--host <標籤>] [--resume] [--force]';
export const options = {
  vendor: { type: 'string' },
  model: { type: 'string' },
  host: { type: 'string' },
  resume: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
};
export const details = [
  '名稱：英數字、底線、連字號，英數字開頭，1 到 31 字元，慣例是 <vendor>-<編號>，例如 claude-1。',
  '本機已有這個名稱的狀態檔（且沒 leave）時拒絕：新開的 session 請換名稱；要接手這個身分（例如對話被壓縮後）加 --resume，保留角色、階段與游標，不重發 [JOIN]。',
  '--force：捨棄本機舊狀態重新進房；也會略過下面的名稱衝突檢查。',
  '建立新身分時，名稱（不分大小寫）在 24 小時內被別人用過（最後一則不是 [LEAVE] 或 [IDLE]）會拒絕，換名稱或加 --force。',
  '有進行中的議題時，會依序套用議題之後主導者的 [ASSIGN]、[GO]、[CONTINUE]、[STOP]，直接到達正確階段。',
];

const VENDORS = ['claude', 'gemini', 'codex', 'other'];
const THREAD_TYPES = new Set([10, 11, 12]);

async function checkChannel(client, room) {
  let ch;
  try {
    ch = await client.channel(room.channelId);
  } catch (e) {
    if (e instanceof DiscordError && (e.status === 404 || e.status === 403)) {
      throw new UserError(`讀不到頻道 ${room.channelId}：請檢查 ${room.file} 的 channelId 與 bot 的頻道權限（${doctorText(room)} 可以逐項檢查）`);
    }
    throw e;
  }
  if (ch.guild_id !== room.guildId) {
    throw new UserError(`頻道 ${room.channelId} 不屬於 room.guildId ${room.guildId}：請檢查 ${room.file}（${doctorText(room)} 可以逐項檢查）`);
  }
  if (THREAD_TYPES.has(ch.type)) throw new UserError(`頻道 ${room.channelId} 是討論串，尚未支援討論串：room.json 的 channelId 請填一般文字頻道`);
}
const RECENT_LIMIT = 200;
const CONFLICT_WINDOW_MS = 24 * 60 * 60 * 1000;

// model、host 是自由文字，壓成一行並限制長度，免得 [JOIN] 超過 Discord 的 2000 字。
function oneLine(value) {
  if (value === undefined) return undefined;
  return [...String(value).replace(/\s+/g, ' ').trim()].slice(0, 100).join('');
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
  if (ctx.values.resume && ctx.values.force) throw new UserError('--resume 與 --force 只能擇一');
  const room = ctx.room;
  const client = ctx.client;
  // §6.3 join 第 1 步：先確認頻道（可讀、屬於 room.guildId、不是討論串），不通過就不建 webhook、不發 [JOIN]。
  await checkChannel(client, room);
  const existing = loadAgent(room.channelId, name);

  if (ctx.values.resume && (!existing || existing.left)) {
    throw new ProtocolError('沒有可接手的身分，請不帶 --resume 進房');
  }
  // 本機已有這個名稱、還沒 leave：可能是本機另一個 session 正在用，預設拒絕；--resume 接手，--force 捨棄重來。
  if (existing && !existing.left && !ctx.values.force) {
    if (!ctx.values.resume) {
      const last = existing.lastActivityAt ? fmtTime(existing.lastActivityAt) : '不明';
      throw new ProtocolError(
        `這個名稱在本機使用中：${name}（最後活動時間 ${last}，階段 ${existing.phase}）。新開的 session 請換名稱；確定要接手這個身分才加 --resume`,
      );
    }
    // 第一行固定，接著是和 status 相同的完整內容。
    const status = await buildStatus(ctx, existing);
    return {
      text: [`重新連線：接手既有身分 ${name}，沒有發 [JOIN]`, ...status.text],
      data: { reconnected: true, room: { name: room.roomName, channelId: room.channelId }, ...status.data, state: publicState(existing, room) },
    };
  }

  const { webhook } = await ensureWebhook(client, room, { verify: true });
  const raws = await fetchRecent(client, room.channelId);
  const now = Date.now();

  // 走到這裡就是要建立新身分（本機沒有狀態檔、狀態檔已 leave，或 --force），檢查頻道裡有沒有別人在用；--force 跳過。
  if (!ctx.values.force) {
    const clash = findConflict(raws, room, name, webhook.id, now);
    if (clash) {
      throw new ProtocolError(
        `名稱 ${name} 在 24 小時內有人用過（最後一則 id=${clash.id}，不是 [LEAVE] 或 [IDLE]）。請換一個名稱，或確定是同一個 agent 時加 --force。`,
      );
    }
  }

  // 空頻道用 '0'：不用本機時鐘，免得時鐘偏快時漏讀剛進房後別人發的訊息。
  // 但 bot 沒有讀取訊息歷史權限時，Discord 回的也是空陣列；用頻道的 last_message_id 分辨，免得之後補上權限時從頭重讀整個頻道。
  let latest = raws.length ? raws[raws.length - 1].id : null;
  if (!latest) {
    const ch = await client.channel(room.channelId).catch(() => null);
    latest = ch?.last_message_id || '0';
  }
  const state = newAgent({
    name,
    vendor,
    model: oneLine(ctx.values.model) || null,
    channelId: room.channelId,
    cursor: latest,
  });

  const messages = normalizeAll(raws, room, state);
  const active = findActiveTopic(messages);
  const notes = [];
  let applied = [];
  if (active) {
    // 議題本身與之後的主導者訊息逐則套用（[ASSIGN]、[GO]、[CONTINUE]、[STOP] 都算），晚進房也能直接到正確階段；
    // 對象用套用當下的狀態判斷，印出對我生效的那幾則。
    const moderatorAfter = active.after.filter((m) => m.kind === 'moderator');
    const result = applyEach(state, [active.topic, ...moderatorAfter], room);
    notes.push(...result.notes);
    applied = result.targeted.filter((m) => m !== active.topic);
  }

  const fields = { vendor, model: oneLine(ctx.values.model), host: oneLine(ctx.values.host) };
  const content = buildMessage('JOIN', name, fields);
  guardSecrets(room, content, []);
  const ids = await sendParts(ctx, state, [content]);
  recordOwnMessages(state, ids);
  if (notes.length) {
    state.lastNotes = notes;
    state.lastNotesAt = new Date().toISOString();
  }
  saveAgent(state);
  appendLog(room.channelId, { dir: 'out', agent: name, tag: 'JOIN', ids, content });

  const rem = reminders(state, room);
  const text = [
    `已進房：${name} → 房間 ${room.roomName}（頻道 ${room.channelId}），已送出 [JOIN]（id=${ids[0]}）。`,
    `語言：${room.language}`,
    ...stateLines(state, room),
  ];
  if (active) {
    text.push('', '進行中的議題：', renderMessage(active.topic, { as: name, room }));
    if (applied.length) text.push('', '之後對你生效的主導者指令：', renderMessages(applied, { as: name, room }));
  }
  const n = section('注意', notes);
  if (n) text.push(n);
  const tail = section('提醒', rem);
  if (tail) text.push(tail);
  return {
    text,
    data: {
      reconnected: false,
      id: ids[0],
      room: { name: room.roomName, channelId: room.channelId },
      state: publicState(state, room),
      topic: active ? publicMessage(active.topic) : null,
      directives: applied.map(publicMessage),
      notes,
      reminders: rem,
    },
  };
}
