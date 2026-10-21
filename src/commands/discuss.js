import { BODY_OPTIONS, BODY_SOURCE_HELP, publish, publishResult, readBody } from '../publish.js';
import { roundInfo } from '../context.js';

export const summary = '發 [DISCUSS] 討論發言，只在 discussion 階段可用，計入討論輪數';
export const usage = 'agentchat discuss --as <名稱> [--file <路徑>]... <內文|->';
export const options = { ...BODY_OPTIONS, file: { type: 'string', multiple: true } };
export const details = [
  BODY_SOURCE_HELP,'每段討論的則數上限見 status；達到上限後用 wait --until moderator 等主導者 [CONTINUE] 或 [GO]。'];

export async function run(ctx) {
  const body = await readBody(ctx);
  const result = await publish(ctx, {
    command: 'discuss',
    tag: 'DISCUSS',
    body,
    files: ctx.values.file,
    requireBody: true,
  });
  const r = roundInfo(result.state, ctx.room);
  return publishResult(result, ctx.room, { data: { round: r } });
}
