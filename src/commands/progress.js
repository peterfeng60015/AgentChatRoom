import { UserError } from '../errors.js';
import { BODY_OPTIONS, BODY_SOURCE_HELP, publish, publishResult, readBody } from '../publish.js';
import { requireAgent } from '../context.js';

export const summary = '發 [PROGRESS] 進度回報，只在 work 階段可用';
export const usage = 'agentchat progress --as <名稱> --percent <0-100> [--eta <文字>] [--file <路徑>]... <內文|->';
export const options = {
  ...BODY_OPTIONS,
  percent: { type: 'string' },
  eta: { type: 'string' },
  file: { type: 'string', multiple: true },
};
export const details = [
  BODY_SOURCE_HELP,'欄位 percent、eta、branch（取自本機狀態）；送出後更新上次回報時間。'];

export async function run(ctx) {
  const raw = ctx.values.percent;
  if (raw === undefined) throw new UserError('缺少 --percent <0-100>');
  if (!/^\d{1,3}$/.test(String(raw).trim()) || Number(raw) > 100) {
    throw new UserError('--percent 必須是 0 到 100 的整數');
  }
  const percent = Number(raw);
  const state = requireAgent(ctx);
  const body = await readBody(ctx);
  const eta = ctx.values.eta !== undefined ? String(ctx.values.eta).replace(/[\r\n]+/g, ' ').trim() : undefined;
  const result = await publish(ctx, {
    command: 'progress',
    tag: 'PROGRESS',
    title: `${percent}%`,
    fields: { percent, eta, branch: state.branch },
    body,
    files: ctx.values.file,
    requireBody: true,
    mutate: (s) => {
      s.lastProgressAt = new Date().toISOString();
    },
  });
  return publishResult(result, ctx.room, { data: { percent } });
}
