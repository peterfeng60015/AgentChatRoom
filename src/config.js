import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './errors.js';

// 工具所在目錄（repo 根目錄）。不看目前工作目錄，所以在任何 repo 裡執行都找得到設定；
// 經由 ~/.local/bin 的 symlink 執行時也解析成實際路徑。
function resolveHome() {
  if (process.env.AGENTCHAT_HOME) return path.resolve(process.env.AGENTCHAT_HOME);
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    return fs.realpathSync(here);
  } catch {
    return here;
  }
}

export const TOOL_HOME = resolveHome();

export const ENV_FILE = path.join(TOOL_HOME, '.env');

export const ROOM_DEFAULTS = {
  roomName: 'default',
  webhookName: 'agentchat',
  language: 'zh-TW',
  defaultRepo: null,
  defaultBase: 'main',
  maxDiscussionRounds: 3,
  waitTimeoutSec: 90,
  pollIntervalSec: 3,
  idleLimitMin: 60,
  progressReminderMin: 15,
  maxFileMB: 10,
  maxUploadMB: 10,
  longTextChars: 6000,
};

const REQUIRED = ['guildId', 'channelId', 'moderatorUserId'];
// 數字欄位：[最小值, 是否必須是整數]。
const NUMERIC = {
  maxDiscussionRounds: [1, true],
  waitTimeoutSec: [0, false],
  pollIntervalSec: [0.05, false],
  idleLimitMin: [1, false],
  progressReminderMin: [0, false],
  maxFileMB: [0.001, false],
  maxUploadMB: [0.001, false],
  longTextChars: [600, true],
};

// 極簡 .env 解析：KEY=VALUE，支援 # 註解、export 前綴與引號。
export function parseEnv(text) {
  const env = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line
      .slice(0, i)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // 沒加引號時，空白之後的 # 是行尾註解。
      value = value.replace(/\s+#.*$/, '');
    }
    env[key] = value;
  }
  return env;
}

export function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
}

// 回傳 { token, source }，找不到時 token 是 null。doctor 要知道來源但不能印出 token。
// token 只能是可見的 ASCII；含換行、空白等字元時 fetch 會丟出帶著整個 token 的錯誤，所以先擋下（訊息不含 token）。
export function findToken() {
  let found = { token: null, source: null };
  if (process.env.DISCORD_BOT_TOKEN) found = { token: process.env.DISCORD_BOT_TOKEN.trim(), source: '環境變數' };
  else {
    const fromFile = loadEnv().DISCORD_BOT_TOKEN;
    if (fromFile) found = { token: fromFile.trim(), source: ENV_FILE };
  }
  if (found.token && !/^[\x21-\x7E]+$/.test(found.token)) {
    throw new UserError(`DISCORD_BOT_TOKEN 含有空白、換行或非 ASCII 字元（來源：${found.source}），請重新貼上 token`);
  }
  return found;
}

export function getToken() {
  const { token } = findToken();
  if (!token) {
    throw new UserError(`找不到 DISCORD_BOT_TOKEN。請複製 .env.example 為 ${ENV_FILE} 並填入 bot token。`);
  }
  return token;
}

export function roomFile(roomName) {
  if (roomName !== undefined && roomName !== null && roomName !== '') {
    // 房間名稱會組進路徑，擋掉 ../ 之類的字元。
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(roomName) || roomName.includes('..')) {
      throw new UserError(`房間名稱只能用英數字、底線、連字號與句點：${roomName}`);
    }
    return path.join(TOOL_HOME, 'config', 'rooms', `${roomName}.json`);
  }
  return path.join(TOOL_HOME, 'config', 'room.json');
}

export function loadRoom(roomName) {
  const file = roomFile(roomName);
  if (!fs.existsSync(file)) throw new UserError(`找不到房間設定檔：${file}`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(`房間設定檔不是合法 JSON：${file}（${e.message}）`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new UserError(`房間設定檔的內容必須是 JSON 物件：${file}`);
  }
  for (const key of REQUIRED) {
    if (json[key] === undefined || json[key] === null || json[key] === '') {
      throw new UserError(`房間設定檔缺少 ${key}：${file}`);
    }
    // Discord ID 超過 JS 數字精度，寫成數字會失真，所以只收字串。
    if (typeof json[key] !== 'string' || !/^\d{1,25}$/.test(json[key])) {
      throw new UserError(`房間設定檔的 ${key} 必須是用引號包起來的數字 ID：${file}`);
    }
  }
  // 選填欄位寫成 null 或空字串時用預設值，不要讓「基準分支：null」或空名稱的 webhook 跑出來。
  const given = Object.fromEntries(Object.entries(json).filter(([, v]) => v !== null && v !== ''));
  const room = { ...ROOM_DEFAULTS, ...given, file };
  for (const [key, [min, integer]] of Object.entries(NUMERIC)) {
    const v = room[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
      throw new UserError(`房間設定檔的 ${key} 必須是${integer ? '整數' : '數字'}，且不小於 ${min}：${file}`);
    }
  }
  for (const key of ['roomName', 'webhookName', 'defaultBase', 'language']) {
    if (typeof room[key] !== 'string') throw new UserError(`房間設定檔的 ${key} 必須是字串：${file}`);
  }
  if (/discord|clyde/i.test(room.webhookName)) {
    throw new UserError(`房間設定檔的 webhookName 不能含 discord 或 clyde（Discord 不接受）：${file}`);
  }
  if (room.defaultRepo !== null && typeof room.defaultRepo !== 'string') {
    throw new UserError(`房間設定檔的 defaultRepo 必須是字串或 null：${file}`);
  }
  return room;
}
