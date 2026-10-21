import fs from 'node:fs';
import path from 'node:path';
import { TOOL_HOME } from '../config.js';
import { UserError } from '../errors.js';

export const summary = '印出 SOP（預設給 agent 的版本）';
export const usage = 'agentchat sop [agent|moderator] [--path]';
export const options = { path: { type: 'boolean', default: false } };
export const details = ['--path 只印 SOP 檔的絕對路徑。'];

export async function run(ctx) {
  const which = ctx.positionals[0] ?? 'agent';
  if (!['agent', 'moderator'].includes(which) || ctx.positionals.length > 1) {
    throw new UserError('sop 只接受 agent 或 moderator');
  }
  const file = path.join(TOOL_HOME, 'SOP', `${which}.md`);
  if (!fs.existsSync(file)) throw new UserError(`找不到 SOP 檔：${file}`);
  if (ctx.values.path) return { text: file, data: { which, path: file } };
  const content = fs.readFileSync(file, 'utf8');
  return { text: content, data: { which, path: file, content } };
}
