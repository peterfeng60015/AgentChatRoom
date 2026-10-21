import { reminders } from '../protocol.js';
import { section } from '../render.js';
import { fetchUnread, publicState, requireAgent, stateLines, unreadLine } from '../context.js';

export const summary = '印出本機狀態、未讀則數與提醒（對話被壓縮後用來找回進度）';
export const usage = 'agentchat status --as <名稱>';
export const options = {};

export async function run(ctx) {
  const room = ctx.room;
  const state = requireAgent(ctx);
  let unread = null;
  let unreadError = null;
  try {
    unread = (await fetchUnread(ctx, state)).length;
  } catch (e) {
    unreadError = e.message;
  }
  const rem = reminders(state, room);
  const text = [`${state.name} @ 房間 ${room.roomName}（頻道 ${room.channelId}）`, ...stateLines(state, room)];
  if (unreadError) text.push(`未讀：無法取得（${unreadError}）`);
  else text.push(unreadLine(unread) ?? '未讀：0 則');
  const tail = section('提醒', rem);
  if (tail) text.push(tail);
  return { text, data: { ...publicState(state, room), unread, reminders: rem } };
}
