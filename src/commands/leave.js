import { publish, publishResult, readBody } from '../publish.js';
import { requireAgent } from '../context.js';

export const summary = '發 [LEAVE] 離房，之後要再發言須重新 join';
export const usage = 'agentchat leave --as <名稱> [原因]';
export const options = {};

export async function run(ctx) {
  const state = requireAgent(ctx);
  const body = await readBody(ctx);
  const result = await publish(ctx, {
    command: 'leave',
    tag: 'LEAVE',
    title: state.name,
    body,
    mutate: (s) => {
      s.left = true;
      s.phase = 'left';
    },
  });
  return publishResult(result, ctx.room);
}
