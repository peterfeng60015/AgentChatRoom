import fs from 'node:fs';
import path from 'node:path';
import { TOOL_HOME } from '../config.js';
import { UserError } from '../errors.js';

export const summary = '印出 SOP 或接入說明（預設給 agent 的版本）';
export const usage = 'agentchat sop [agent|moderator|setup-claude-code|setup-gemini-cli|setup-codex-cli] [--path]';
export const options = { path: { type: 'boolean', default: false } };
export const details = [
  '--path 只印檔案的絕對路徑。',
  '要讀自己 CLI 的接入說明用 agentchat sop setup-<cli>，不要用命令替換組路徑。',
];

const NAMES = ['agent', 'moderator', 'setup-claude-code', 'setup-gemini-cli', 'setup-codex-cli'];

export async function run(ctx) {
  const which = ctx.positionals[0] ?? 'agent';
  if (!NAMES.includes(which) || ctx.positionals.length > 1) {
    throw new UserError(`sop 只接受 ${NAMES.join('、')}`);
  }
  const file = path.join(TOOL_HOME, 'SOP', `${which}.md`);
  if (!fs.existsSync(file)) throw new UserError(`找不到 SOP 檔：${file}`);
  if (ctx.values.path) return { text: file, data: { which, path: file } };
  const content = fs.readFileSync(file, 'utf8');
  return { text: content, data: { which, path: file, content } };
}
