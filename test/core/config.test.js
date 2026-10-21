// src/config.js 的單元測試（SPEC §3.1、§3.2、§7.2）。
// TOOL_HOME 在模組載入時決定，所以先設 AGENTCHAT_HOME 再動態 import；
// 需要不同環境的情境用 `?<標記>` 另外載入一份模組，避免共用同一份快取。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const CONFIG_URL = pathToFileURL(path.join(SRC_DIR, 'config.js')).href;

// realpath：macOS 的暫存目錄經過 symlink，實作若解析成實際路徑也要比得上。
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-config-')));
const HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(path.join(HOME, 'config', 'rooms'), { recursive: true });

const savedEnv = { home: process.env.AGENTCHAT_HOME, token: process.env.DISCORD_BOT_TOKEN };
process.env.AGENTCHAT_HOME = HOME;
delete process.env.DISCORD_BOT_TOKEN;

const config = await import(CONFIG_URL);
const { UserError } = await import(pathToFileURL(path.join(SRC_DIR, 'errors.js')).href);
const { parseEnv, getToken, roomFile, loadRoom } = config;

after(() => {
  if (savedEnv.home === undefined) delete process.env.AGENTCHAT_HOME;
  else process.env.AGENTCHAT_HOME = savedEnv.home;
  if (savedEnv.token === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = savedEnv.token;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const REQUIRED = { guildId: '100', channelId: '200', moderatorUserId: '300' };

// §3.1 的全部預設值。
const DEFAULTS = {
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
  longTextChars: 6000,
};

function writeRoom(obj, file = path.join(HOME, 'config', 'room.json')) {
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return file;
}

const isUserError = (e) => e instanceof UserError;

// 在指定的環境變數下載入另一份 config.js（不影響上面那份）。
async function importWith(env, mark, { cwd } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const savedCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    return await import(`${CONFIG_URL}?${mark}`);
  } finally {
    if (cwd) process.chdir(savedCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---- parseEnv ----

test('parseEnv：註解、空行、引號、值裡的等號', () => {
  const text = [
    '# 註解',
    '',
    'DISCORD_BOT_TOKEN=abc.def=ghi==',
    '   # 縮排的註解',
    'DOUBLE="hello world"',
    "SINGLE='x=y'",
    '',
    'PLAIN=value',
  ].join('\n');
  assert.deepEqual(parseEnv(text), {
    DISCORD_BOT_TOKEN: 'abc.def=ghi==',
    DOUBLE: 'hello world',
    SINGLE: 'x=y',
    PLAIN: 'value',
  });
});

test('parseEnv：空字串回空物件', () => {
  assert.deepEqual(parseEnv(''), {});
});

// ---- TOOL_HOME、ENV_FILE、roomFile ----

test('AGENTCHAT_HOME 覆寫工具目錄，ENV_FILE 在工具目錄下', () => {
  assert.equal(config.TOOL_HOME, HOME);
  assert.equal(config.ENV_FILE, path.join(HOME, '.env'));
});

test('沒有 AGENTCHAT_HOME 時，工具目錄是 src/ 的上一層，與目前工作目錄無關', async () => {
  const other = path.join(tmpRoot, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  const c = await importWith({ AGENTCHAT_HOME: undefined }, 'default-home', { cwd: other });
  assert.equal(c.TOOL_HOME, fs.realpathSync(path.resolve(SRC_DIR, '..')));
  assert.equal(c.ENV_FILE, path.join(c.TOOL_HOME, '.env'));
});

test('經由 symlink 載入時，工具目錄解析成實際路徑', async () => {
  const link = path.join(tmpRoot, 'link-to-tool');
  fs.symlinkSync(path.resolve(SRC_DIR, '..'), link, 'dir');
  const saved = process.env.AGENTCHAT_HOME;
  delete process.env.AGENTCHAT_HOME;
  try {
    const c = await import(`${pathToFileURL(path.join(link, 'src', 'config.js')).href}?via-symlink`);
    assert.equal(c.TOOL_HOME, fs.realpathSync(path.resolve(SRC_DIR, '..')));
  } finally {
    process.env.AGENTCHAT_HOME = saved;
  }
});

test('roomFile：沒給名稱是 config/room.json，--room 名稱是 config/rooms/<名稱>.json', () => {
  assert.equal(roomFile(), path.join(HOME, 'config', 'room.json'));
  assert.equal(roomFile(undefined), path.join(HOME, 'config', 'room.json'));
  assert.equal(roomFile('lab'), path.join(HOME, 'config', 'rooms', 'lab.json'));
});

// ---- loadRoom ----

test('loadRoom：只有必填欄位時合併 §3.1 全部預設值，另加 file', () => {
  const file = writeRoom(REQUIRED);
  assert.deepEqual(loadRoom(), { ...DEFAULTS, ...REQUIRED, file });
});

test('loadRoom：設定檔的值覆寫預設值', () => {
  const custom = {
    ...REQUIRED,
    roomName: 'lab',
    webhookName: 'hook',
    defaultRepo: '/repo',
    maxDiscussionRounds: 5,
    waitTimeoutSec: 30,
    maxFileMB: 8,
    longTextChars: 3000,
  };
  const file = writeRoom(custom);
  assert.deepEqual(loadRoom(), { ...DEFAULTS, ...custom, file });
});

for (const key of Object.keys(REQUIRED)) {
  test(`loadRoom：缺必填欄位 ${key} 丟 UserError`, () => {
    const room = { ...REQUIRED };
    delete room[key];
    writeRoom(room);
    assert.throws(() => loadRoom(), isUserError);
  });
}

test('loadRoom：JSON 不合法丟 UserError', () => {
  writeRoom('{ "guildId": "100", ');
  assert.throws(() => loadRoom(), isUserError);
});

test('loadRoom：--room 名稱讀 config/rooms/<名稱>.json', () => {
  writeRoom(REQUIRED);
  const file = writeRoom({ ...REQUIRED, channelId: '999', roomName: 'lab' }, path.join(HOME, 'config', 'rooms', 'lab.json'));
  const room = loadRoom('lab');
  assert.equal(room.channelId, '999');
  assert.equal(room.roomName, 'lab');
  assert.equal(room.file, file);
  assert.equal(room.maxDiscussionRounds, DEFAULTS.maxDiscussionRounds);
});

test('loadRoom：--room 的設定檔也檢查必填欄位', () => {
  writeRoom({ guildId: '1' }, path.join(HOME, 'config', 'rooms', 'broken.json'));
  assert.throws(() => loadRoom('broken'), isUserError);
});

test('loadRoom：設定檔不存在丟 UserError', () => {
  assert.throws(() => loadRoom('no-such-room'), isUserError);
});

// ---- loadEnv ----

test('loadEnv：讀 <工具目錄>/.env；檔案不存在時回空物件', async () => {
  fs.writeFileSync(path.join(HOME, '.env'), '# c\nDISCORD_BOT_TOKEN=abc\nOTHER="x y"\n');
  assert.deepEqual(config.loadEnv(), { DISCORD_BOT_TOKEN: 'abc', OTHER: 'x y' });
  const none = path.join(tmpRoot, 'no-env-home');
  fs.mkdirSync(none, { recursive: true });
  const c = await importWith({ AGENTCHAT_HOME: none }, 'no-env');
  assert.deepEqual(c.loadEnv(), {});
});

// ---- getToken ----

test('getToken：環境變數優先於 .env', () => {
  fs.writeFileSync(path.join(HOME, '.env'), 'DISCORD_BOT_TOKEN=from-file\n');
  process.env.DISCORD_BOT_TOKEN = 'from-env';
  try {
    assert.equal(getToken(), 'from-env');
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
  }
});

test('getToken：沒有環境變數時讀 <工具目錄>/.env', () => {
  fs.writeFileSync(path.join(HOME, '.env'), '# 註解\nDISCORD_BOT_TOKEN="from-file"\n');
  assert.equal(getToken(), 'from-file');
});

test('getToken：兩邊都沒有時丟 UserError', async () => {
  const empty = path.join(tmpRoot, 'empty-home');
  fs.mkdirSync(empty, { recursive: true });
  const c = await importWith({ AGENTCHAT_HOME: empty, DISCORD_BOT_TOKEN: undefined }, 'no-token');
  assert.throws(() => c.getToken(), isUserError);
});

test('getToken：.env 裡 token 是空值時也丟 UserError', async () => {
  const blank = path.join(tmpRoot, 'blank-home');
  fs.mkdirSync(blank, { recursive: true });
  fs.writeFileSync(path.join(blank, '.env'), 'DISCORD_BOT_TOKEN=\n');
  const c = await importWith({ AGENTCHAT_HOME: blank, DISCORD_BOT_TOKEN: undefined }, 'blank-token');
  assert.throws(() => c.getToken(), isUserError);
});
