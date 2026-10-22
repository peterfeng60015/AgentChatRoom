// 把訊息整理成給 AI 讀的精簡文字。

export function kindLabel(kind) {
  return { moderator: '主導者', agent: 'agent', self: '你', human: '人類', bot: 'bot' }[kind] || kind;
}

export function fmtSize(n) {
  if (!Number.isFinite(n)) return '大小不明';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '時間不明';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// §9 輸出清理：來自頻道的字串裡，會影響終端機或排版的控制字元一律換成 U+FFFD：
// C0（保留 \t 與換行）、DEL、C1、U+2028／U+2029、雙向文字控制字元（U+202A–U+202E、U+2066–U+2069）。
const UNSAFE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export function cleanText(text) {
  return String(text ?? '').replace(UNSAFE_CHARS, '\ufffd');
}
// 作者名稱、附檔名這類單行的值：換行換成空白（免得跳出縮排、偽造結構行），其餘控制字元照 cleanText。
export function oneLine(text) {
  return cleanText(String(text ?? '').replace(/\r\n?|\n/g, ' '));
}
export const CONTENT_PREFIX = '│ ';

// 格式固定（§7.5），SOP 依賴它：第一行 `[時間] <作者標示>  (id=…)`，提到我或指令對我生效時行尾加 `  ← 提到你`；
// 接著是訊息原文，每行前面加 `│ `（工具產生的結構行一律頂格，別人沒辦法在內文裡偽造主導者訊息或「注意」），
// 然後是頂格的附檔行。as 是讀訊息的 agent 名稱、room 是房間設定，用來印出可以直接複製的 download 指令。
export function renderMessage(m, { as, room } = {}) {
  let who = `${kindLabel(m.kind)} ${oneLine(m.author)}`;
  if (m.kind === 'agent' && m.authorRole) who += ` (${oneLine(m.authorRole)})`;
  const flag = m.mentionsMe || m.targetsMe ? '  ← 提到你' : '';
  const lines = [`[${fmtTime(m.timestamp)}] ${who}  (id=${m.id})${flag}`];
  if (m.content) {
    lines.push(...m.content.replace(/\r\n?/g, '\n').split('\n').map((l) => CONTENT_PREFIX + cleanText(l)));
  } else if (!m.attachments.length && (m.kind === 'moderator' || m.kind === 'human')) {
    // 沒有原文可印；最常見的原因是沒開 Message Content Intent，提示一下免得 agent 以為對方沒說話。
    lines.push('（無文字內容。若對方明明有打字，代表 bot 的 Message Content Intent 沒開）');
  }
  for (const a of m.attachments) {
    const r = room?.roomArg ? ` --room ${room.roomArg}` : '';
    lines.push(`附檔：${oneLine(a.filename)}（${fmtSize(a.size)}）→ agentchat download --as ${as || '<你的名稱>'}${r} ${m.id}`);
  }
  return lines.join('\n');
}

export function renderMessages(messages, opts = {}) {
  return messages.map((m) => renderMessage(m, opts)).join('\n---\n');
}

export function section(title, items) {
  if (!items || !items.length) return '';
  return `\n${title}\n${items.map((x) => `- ${x}`).join('\n')}`;
}
