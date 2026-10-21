import { publish, publishResult, readBody } from '../publish.js';
import { requireAgent } from '../context.js';

export const summary = '發 [ACK] 回覆收到指派與自己的理解，只在 discussion 階段可用';
export const usage = 'agentchat ack --as <名稱> [內文|-]';
export const options = {};
export const details = ['欄位 role、branch 取自本機狀態；內文寫你對分工的理解。'];

export async function run(ctx) {
  const state = requireAgent(ctx);
  const body = await readBody(ctx);
  const result = await publish(ctx, {
    command: 'ack',
    tag: 'ACK',
    fields: { role: state.role, branch: state.branch },
    body,
  });
  return publishResult(result, ctx.room);
}
