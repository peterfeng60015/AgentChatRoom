import { reminders } from '../protocol.js';
import { fmtTime, section } from '../render.js';
import { countUnread, effectiveLines, publicState, requireAgent, stateLines, unreadText } from '../context.js';

export const summary = '印出本機狀態、未讀則數與提醒（對話被壓縮後用來找回進度）';
export const usage = 'agentchat status --as <名稱>';
export const options = {};

// status 的完整內容；join --resume 在固定的第一行之後也印這一份（§6.3）。
export async function buildStatus(ctx, state) {
  const room = ctx.room;
  let unread = null;
  let unreadError = null;
  try {
    unread = await countUnread(ctx, state);
  } catch (e) {
    unreadError = e.message;
  }
  const rem = reminders(state, room);
  const text = [`${state.name} @ 房間 ${room.roomName}（頻道 ${room.channelId}）`, ...stateLines(state, room), ...effectiveLines(state, room)];
  if (unreadError) text.push(`未讀：無法取得（${unreadError}）`);
  else {
    const hint = unread.count ? `，先用 agentchat wait --as ${state.name} --timeout 0 讀取` : '';
    text.push(`未讀：${unreadText(unread)} 則${hint}`);
  }
  // 最近一次 wait／join 的注意（附時間，讓 agent 判斷是不是舊的）：輸出被截掉或對話壓縮後可以在這裡找回。
  const when = state.lastNotesAt ? `（${fmtTime(state.lastNotesAt)}）` : '';
  const last = section(`最近一次的注意${when}`, state.lastNotes || []);
  if (last) text.push(last);
  const tail = section('提醒', rem);
  if (tail) text.push(tail);
  const f = state.topic?.fields || {};
  return {
    text,
    data: {
      ...publicState(state, room),
      language: room.language,
      repo: f.repo || room.defaultRepo || null,
      base: f.base || room.defaultBase,
      lastNotes: state.lastNotes || [],
      lastNotesAt: state.lastNotesAt ?? null,
      unread: unread?.count ?? null,
      unreadCapped: unread?.capped ?? null,
      reminders: rem,
    },
  };
}

export async function run(ctx) {
  return buildStatus(ctx, requireAgent(ctx));
}
