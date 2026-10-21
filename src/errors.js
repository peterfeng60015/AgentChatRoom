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

// Discord API 回傳的錯誤，附上 HTTP 狀態與提示。
export class DiscordError extends Error {
  constructor(status, data, hint) {
    const detail = data && typeof data === 'object' && data.message ? `：${data.message}` : '';
    super(`${hint || `Discord API 錯誤（HTTP ${status}）`}${detail}`);
    this.name = 'DiscordError';
    this.status = status;
    this.data = data;
    this.exitCode = 1;
  }
}

export function exitCodeOf(error) {
  return Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
