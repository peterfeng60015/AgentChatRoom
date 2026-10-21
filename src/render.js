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

// as 是讀訊息的 agent 名稱，用來印出可以直接複製的 download 指令。
export function renderMessage(m, { as } = {}) {
  let who;
  if (m.kind === 'moderator') who = `主導者 ${m.author}`;
  else if (m.kind === 'agent' || m.kind === 'self') {
    who = `${kindLabel(m.kind)} ${m.author}${m.authorRole ? ` (${m.authorRole})` : ''}`;
  } else who = `${kindLabel(m.kind)} ${m.author}`;
  const flags = [];
  if (m.targetsMe) flags.push('← 對你的指令');
  else if (m.mentionsMe) flags.push('← 提到你');
  if (m.replyTo) flags.push(`回覆 id=${m.replyTo}`);
  const lines = [`[${fmtTime(m.timestamp)}] ${who}${flags.length ? '  ' + flags.join('，') : ''}  (id=${m.id})`];
  if (m.content) {
    lines.push(m.content);
  } else if (!m.attachments.length && (m.kind === 'moderator' || m.kind === 'human')) {
    lines.push('（無文字內容。若對方明明有打字，代表 bot 的 Message Content Intent 沒開）');
  }
  for (const a of m.attachments) {
    lines.push(`附檔：${a.filename}（${fmtSize(a.size)}）→ agentchat download --as ${as || '<你的名稱>'} ${m.id}`);
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
