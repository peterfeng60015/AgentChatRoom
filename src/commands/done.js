import { publish, publishResult, readBody } from '../publish.js';
import { requireAgent } from '../context.js';

export const summary = '發 [DONE] 完成分工，只在 work 階段可用，階段改為 done';
export const usage =
  'agentchat done --as <名稱> [--branch <分支>] [--worktree <路徑>] [--commit <SHA>] [--file <路徑>]... <摘要|->';
export const options = {
  branch: { type: 'string' },
  worktree: { type: 'string' },
  commit: { type: 'string' },
  file: { type: 'string', multiple: true },
};
export const details = ['--branch 預設取自本機狀態。'];

const oneLine = (v) => (v === undefined ? undefined : String(v).replace(/[\r\n]+/g, ' ').trim());

export async function run(ctx) {
  const state = requireAgent(ctx);
  const body = await readBody(ctx);
  const result = await publish(ctx, {
    command: 'done',
    tag: 'DONE',
    fields: {
      branch: oneLine(ctx.values.branch) ?? state.branch,
      worktree: oneLine(ctx.values.worktree),
      commit: oneLine(ctx.values.commit),
    },
    body,
    files: ctx.values.file,
    requireBody: true,
    mutate: (s) => {
      s.phase = 'done';
    },
  });
  return publishResult(result, ctx.room);
}
