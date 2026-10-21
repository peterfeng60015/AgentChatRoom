// 使用者可自行排除的錯誤（設定缺漏、參數錯誤等），CLI 只印訊息不印 stack。
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
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
  }
}
