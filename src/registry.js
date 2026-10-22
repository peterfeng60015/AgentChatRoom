// 指令清單（help 的列出順序）。每個指令一個檔：src/commands/<名稱>.js，
// 匯出 summary、usage、options、run，選擇性匯出 details（help <指令> 的補充說明）。
export const COMMANDS = [
  'help',
  'sop',
  'doctor',
  'join',
  'status',
  'read',
  'wait',
  'post',
  'discuss',
  'ack',
  'ask',
  'progress',
  'done',
  'leave',
  'avatar',
  'download',
  'clear',
];

export function isCommand(name) {
  return COMMANDS.includes(name);
}

// 只載入清單裡的名稱，不會因為使用者輸入而 import 任意路徑。
export function loadCommand(name) {
  if (!isCommand(name)) throw new Error(`unknown command ${name}`);
  return import(`./commands/${name}.js`);
}

export function renderUsage(name, mod) {
  const lines = [`用法：${mod.usage}`, '', mod.summary];
  if (mod.details?.length) lines.push('', ...mod.details);
  lines.push('', '共通選項：--as <名稱>、--room <名稱>、--json、-h/--help');
  return lines.join('\n');
}
