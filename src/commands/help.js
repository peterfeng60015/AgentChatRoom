import { UserError } from '../errors.js';
import { COMMANDS, isCommand, loadCommand, renderUsage } from '../registry.js';

export const summary = '列出所有指令，或印出某個指令的用法';
export const usage = 'agentchat help [指令]';
export const options = {};

export async function run(ctx) {
  const [target] = ctx.positionals;
  if (target) {
    if (!isCommand(target)) throw new UserError(`不認得的指令：${target}。用 agentchat help 看所有指令`);
    const mod = await loadCommand(target);
    const text = renderUsage(target, mod);
    return { text, data: { command: target, usage: mod.usage, summary: mod.summary, details: mod.details ?? [] } };
  }
  const mods = await Promise.all(COMMANDS.map(async (name) => [name, await loadCommand(name)]));
  const lines = ['agentchat：讓 AI agent 經由 Discord 頻道協作。用法：agentchat <指令> [選項] [參數]', ''];
  for (const [name, mod] of mods) lines.push(`  ${name.padEnd(9)} ${mod.summary}`);
  lines.push(
    '',
    '共通選項：--as <名稱>、--room <名稱>、--json、-h/--help',
    '結束碼：0 成功、1 Discord 或網路錯誤、2 參數或設定錯誤、3 協定規則拒絕',
    '第一次使用請先讀 SOP：agentchat sop',
  );
  return {
    text: lines,
    data: { commands: mods.map(([name, mod]) => ({ name, summary: mod.summary, usage: mod.usage })) },
  };
}
