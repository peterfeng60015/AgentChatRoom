import { toInt } from '../args.js';
import { compareSnowflake, snowflakeNow } from '../discord.js';
import { ProtocolError, UserError } from '../errors.js';
import { LEFT_TEXT, applyEach, buildMessage, reminders } from '../protocol.js';
import { kindLabel, renderMessages, section } from '../render.js';
import { acquireWaitLock, appendLog, loadAgent, recordOwnMessages, updateAgent } from '../state.js';
import { normalizeAll, phaseOf, publicMessage, requireAgent, roundInfo, summaryLine } from '../context.js';
import { sendParts } from '../publish.js';

export const summary = '長輪詢等新訊息，套用主導者指令並移動游標';
export const usage = 'agentchat wait --as <名稱> [--timeout <秒>] [--until any|mention|moderator]';
export const options = { timeout: { type: 'string' }, until: { type: 'string' } };
export const details = [
  '--timeout 預設 room.json 的 waitTimeoutSec，範圍 0 到 540；0 表示只查一次、不等待。',
  '--until any：任何不是自己的新訊息（預設）；mention：提到你、回覆你，或主導者對你生效的指令；moderator：任何主導者訊息。',
  '輸出累積到的全部新訊息（不只符合條件的那幾則），以及「注意」與「提醒」。逾時也是結束碼 0。',
];

const MAX_TIMEOUT = 540;
// 單次輸出上限（§6.3）：太長的輸出會被 agent 的工具截掉，沒輸出的留給下一次 wait。
export const MAX_BATCH = 50;
const UNTIL = ['any', 'mention', 'moderator'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function whoOf(m) {
  return m.kind === 'moderator' ? '主導者' : `${kindLabel(m.kind)} ${m.author}`;
}

function matchReason(m, until) {
  if (until === 'any') return m.kind === 'moderator' ? '主導者發言' : `${whoOf(m)} 發言`;
  if (until === 'moderator') return m.kind === 'moderator' ? '主導者發言' : null;
  if (m.targetsMe) return `主導者 [${m.tag}] 對你生效`;
  if (m.mentionsMe) return `${whoOf(m)} 提到你`;
  return null;
}

export async function run(ctx) {
  const room = ctx.room;
  const initial = requireAgent(ctx);
  if (initial.left || initial.phase === 'left') {
    throw new ProtocolError(LEFT_TEXT);
  }
  const timeout = toInt(ctx.values.timeout, Math.min(MAX_TIMEOUT, Math.round(room.waitTimeoutSec)), '--timeout');
  if (timeout > MAX_TIMEOUT) throw new UserError(`--timeout 範圍是 0 到 ${MAX_TIMEOUT} 秒`);
  const until = ctx.values.until ?? 'any';
  if (!UNTIL.includes(until)) throw new UserError(`--until 只接受 ${UNTIL.join('、')}`);
  const release = acquireWaitLock(room.channelId, initial.name);
  try {
    return await waitLocked(ctx, room, initial, timeout, until);
  } finally {
    release();
  }
}

async function waitLocked(ctx, room, initial, timeout, until) {
  // §5.4：只有 --timeout > 0 且不在 work 階段的 wait 才計無人回應的時間；開始時 emptyWaitSince 是 null 就設為現在。
  const timed = timeout > 0 && initial.phase !== 'work';
  const state = updateAgent(room.channelId, initial.name, (s) => {
    if (timed && !s.emptyWaitSince) s.emptyWaitSince = new Date().toISOString();
    if (!s.cursor) s.cursor = snowflakeNow();
  });

  const client = ctx.client;
  const deadline = Date.now() + timeout * 1000;
  const pollMs = Math.max(50, room.pollIntervalSec * 1000);
  let lastSeen = state.cursor;
  const collected = [];
  const seen = new Set();
  let reason = null;

  for (;;) {
    // 一次最多抓兩頁就好：超過 MAX_BATCH 則就結束，剩下的留給下一次 wait。
    const raws = await client.messagesAfter(room.channelId, lastSeen, 2);
    for (const raw of raws) if (compareSnowflake(raw.id, lastSeen) > 0) lastSeen = raw.id;
    // 每輪重讀狀態檔：等待期間同一個 agent 可能另外 ask 或發言，回覆那些訊息也要算「提到我」。
    const live = loadAgent(room.channelId, state.name) ?? state;
    for (const m of normalizeAll(raws, room, live)) {
      if (m.kind === 'self' || seen.has(m.id)) continue;
      seen.add(m.id);
      collected.push(m);
      if (collected.length <= MAX_BATCH) reason ??= matchReason(m, until);
    }
    if (reason || collected.length > MAX_BATCH) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  // 超過上限時只處理最舊的 MAX_BATCH 則，游標也只移到其中最後一則。
  const partial = collected.length > MAX_BATCH;
  const batch = partial ? collected.slice(0, MAX_BATCH) : collected;
  const newCursor = partial ? batch[batch.length - 1].id : lastSeen;

  // 套用指令前重新讀檔：等待期間同一個 agent 可能已經發言（ownMessageIds、輪數有變）。
  // 只套用游標之後的訊息：同一個 agent 另一個 wait 若已經套用過、把游標移過去，不能再套用一次。
  let notes = [];
  let updated = updateAgent(room.channelId, state.name, (s) => {
    const fresh = batch.filter((m) => !s.cursor || compareSnowflake(m.id, s.cursor) > 0);
    ({ notes } = applyEach(s, fresh, room));
    // §5.1：注意存進 lastNotes，status 可以再印一次；沒有新的就保留上一次。
    if (notes.length) {
      s.lastNotes = notes;
      s.lastNotesAt = new Date().toISOString();
    }
    if (!s.cursor || compareSnowflake(newCursor, s.cursor) > 0) s.cursor = newCursor;
  });
  if (batch.length) {
    appendLog(room.channelId, { dir: 'in', agent: state.name, ids: batch.map((m) => m.id) });
  }

  let status = partial ? 'partial' : reason ? 'matched' : 'timeout';
  // 沒有符合條件的新訊息、而且計時沒被重設（別人只是進出房或發 [IDLE]）時才可能觸發。
  if (timed && status === 'timeout' && !['work', 'idle', 'left'].includes(updated.phase)) {
    const since = Date.parse(updated.emptyWaitSince);
    if (Number.isFinite(since) && Date.now() - since >= room.idleLimitMin * 60000) {
      const content = buildMessage(
        'IDLE',
        updated.name,
        {},
        `連續 ${room.idleLimitMin} 分鐘沒有任何新訊息，自動結束等待。`,
      );
      const ids = await sendParts(ctx, updated, [content]);
      updated = updateAgent(room.channelId, state.name, (s) => {
        recordOwnMessages(s, ids);
        s.phase = 'idle';
      });
      appendLog(room.channelId, { dir: 'out', agent: state.name, tag: 'IDLE', ids, content });
      status = 'idle';
    }
  }

  const others = batch.length;
  const statusLine = {
    matched: `狀態：符合條件（${reason}）`,
    timeout: others ? `狀態：逾時，有 ${others} 則其他新訊息` : '狀態：逾時，沒有新訊息',
    idle: '狀態：已自動發出 [IDLE]',
    partial: `狀態：還有未讀，先處理這 ${MAX_BATCH} 則，再執行 agentchat wait --as ${updated.name} --timeout 0`,
  }[status];
  const rem = reminders(updated, room);
  // 注意與提醒放在訊息前面：輸出很長時，agent 的工具常只顯示開頭。
  const text = [statusLine, summaryLine(updated, room)];
  const n = section('注意', notes);
  if (n) text.push(n);
  const r = section('提醒', rem);
  if (r) text.push(r);
  if (batch.length) text.push('', renderMessages(batch, { as: updated.name }));
  return {
    text,
    data: {
      status,
      reason,
      phase: phaseOf(updated),
      role: updated.role,
      round: roundInfo(updated, room),
      messages: batch.map(publicMessage),
      notes,
      reminders: rem,
    },
  };
}
