import { publish, publishResult, readBody } from '../publish.js';
import { requireAgent } from '../context.js';

export const summary = '發 [LEAVE] 離房；之後不要再 wait 或重新 join';
export const usage = 'agentchat leave --as <名稱> [原因|-]';
export const options = {};

export async function run(ctx) {
  const state = requireAgent(ctx);
  const body = await readBody(ctx);
  const result = await publish(ctx, {
    command: 'leave',
    tag: 'LEAVE',
    title: state.name,
    body,
    countUnread: false,
    mutate: (s) => {
      s.left = true;
      s.phase = 'left';
    },
  });
  return publishResult(result, ctx.room, { showUnread: false, lines: ['已離開，不要再 wait 或重新 join'] });
}
