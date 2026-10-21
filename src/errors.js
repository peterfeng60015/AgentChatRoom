// 錯誤種類對應 §6.1 的結束碼：1 Discord 或網路、2 參數或設定、3 協定規則拒絕。

// 使用者可自行排除的錯誤（設定缺漏、參數錯誤等），CLI 只印訊息不印 stack。
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.exitCode = 2;
  }
}

// 協定規則拒絕：階段不允許、輪數已滿、名稱衝突、agent 發主導者標籤。
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.exitCode = 3;
  }
}

// 400 的 Invalid Form Body 把真正原因放在 errors 樹裡（例如 username 含 discord），取前幾則出來。
function formErrors(errors) {
  const found = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object' || found.length >= 3) return;
    if (Array.isArray(node._errors)) {
      for (const e of node._errors) found.push(`${path || '(body)'}：${e.message || e.code}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(errors, '');
  return found.slice(0, 3);
}

// Discord API 回傳的錯誤，附上 HTTP 狀態與提示。
export class DiscordError extends Error {
  constructor(status, data, hint) {
    let detail = data && typeof data === 'object' && data.message ? `：${data.message}` : '';
    const reasons = data && typeof data === 'object' ? formErrors(data.errors) : [];
    if (reasons.length) detail += `（${reasons.join('；')}）`;
    super(`${hint || `Discord API 錯誤（HTTP ${status}）`}${detail}`);
    this.name = 'DiscordError';
    this.status = status;
    this.data = data;
    // 413 是檔案太大，屬於使用者可以自己修正的問題（§6.2）。
    this.exitCode = status === 413 ? 2 : 1;
  }
}

export function exitCodeOf(error) {
  return Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
