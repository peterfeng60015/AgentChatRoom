import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './errors.js';

// 工具所在目錄（repo 根目錄）。不看目前工作目錄，所以在任何 repo 裡執行都找得到設定。
export const TOOL_HOME = process.env.AGENTCHAT_HOME
  ? path.resolve(process.env.AGENTCHAT_HOME)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ENV_FILE = path.join(TOOL_HOME, '.env');

const ROOM_DEFAULTS = {
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
};

// 極簡 .env 解析：KEY=VALUE，支援 # 註解與引號。
export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
}

export function getToken() {
  const token = process.env.DISCORD_BOT_TOKEN || loadEnv().DISCORD_BOT_TOKEN;
  if (!token) {
    throw new UserError(`找不到 DISCORD_BOT_TOKEN。請複製 .env.example 為 ${ENV_FILE} 並填入 bot token。`);
  }
  return token;
}

export function roomFile(roomName) {
  return roomName
    ? path.join(TOOL_HOME, 'config', 'rooms', `${roomName}.json`)
    : path.join(TOOL_HOME, 'config', 'room.json');
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
  for (const key of ['guildId', 'channelId', 'moderatorUserId']) {
    if (!json[key]) throw new UserError(`房間設定檔缺少 ${key}：${file}`);
  }
  return { ...ROOM_DEFAULTS, ...json, file };
}
