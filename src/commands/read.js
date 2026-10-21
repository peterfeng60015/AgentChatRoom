import { UserError } from '../errors.js';
import { toInt } from '../args.js';
import { renderMessages } from '../render.js';
import { loadAgent } from '../state.js';
import { agentName, normalizeAll, publicMessage } from '../context.js';

export const summary = '印出頻道最近 N 則訊息（不移動游標、不套用指令）';
export const usage = 'agentchat read [--as <名稱>] [--last <N>]';
export const options = { last: { type: 'string' } };
export const details = ['--last 預設 20，最多 100，舊的在前。沒有 --as 時不判斷「你」與「提到你」。'];

export async function run(ctx) {
  const room = ctx.room;
  const n = toInt(ctx.values.last, 20, '--last');
  if (n < 1) throw new UserError('--last 至少是 1');
  const limit = Math.min(100, n);
  let self = null;
  if (ctx.values.as) {
    const name = agentName(ctx);
    // read 不需要先 join；沒有狀態檔時只用名稱判斷「你」。
    self = loadAgent(room.channelId, name) ?? { name, role: null, ownMessageIds: [] };
  }
  const raws = await ctx.client.messages(room.channelId, { limit });
  const list = normalizeAll(raws, room, self);
  const head = list.length ? `頻道最近 ${list.length} 則（舊的在前）：` : '頻道目前沒有訊息。';
  return {
    text: list.length ? [head, renderMessages(list, { as: self?.name })] : head,
    data: { messages: list.map(publicMessage) },
  };
}
