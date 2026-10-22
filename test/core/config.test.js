// src/config.js 的單元測試（SPEC §3.1、§3.2、§7.2）。
// TOOL_HOME 在模組載入時決定，所以先設 AGENTCHAT_HOME 再動態 import；
// 需要不同環境的情境用 `?<標記>` 另外載入一份模組，避免共用同一份快取。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

const restoreEnv = () => {
  if (savedEnv.home === undefined) delete process.env.AGENTCHAT_HOME;
  else process.env.AGENTCHAT_HOME = savedEnv.home;
  if (savedEnv.token === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = savedEnv.token;
};

const config = await import(CONFIG_URL);
if (config.TOOL_HOME !== HOME) {
  // 工具目錄沒吃到 AGENTCHAT_HOME 時，後面的斷言會讀到真正的 .env，失敗訊息可能印出 token，所以整檔中止。
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  throw new Error(`TOOL_HOME 沒有讀 AGENTCHAT_HOME（得到 ${config.TOOL_HOME}），中止整檔`);
}
const { UserError } = await import(pathToFileURL(path.join(SRC_DIR, 'errors.js')).href);
const { parseEnv, getToken, roomFile, loadRoom } = config;

after(() => {
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const REQUIRED = { guildId: '100000000000000001', channelId: '100000000000000002', moderatorUserId: '100000000000000003' };

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
  maxUploadMB: 10,
  longTextChars: 6000,
  avatarUrlTemplate: 'https://api.dicebear.com/10.x/{style}/png?seed={name}&size=128',
  avatarStyles: { claude: 'bottts', gemini: 'pixel-art', codex: 'adventurer', other: 'identicon' },
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

test('經由 symlink 載入時，工具目錄解析成實際路徑', () => {
  // Node 預設就把 import.meta.url 解析成實際路徑，在同一個行程裡驗不出實作有沒有 realpath；
  // 用 --preserve-symlinks 的子行程經由 symlink 載入，才分得出來。
  const link = path.join(tmpRoot, 'link-to-tool');
  fs.symlinkSync(path.resolve(SRC_DIR, '..'), link, 'dir');
  const env = { ...process.env };
  delete env.AGENTCHAT_HOME;
  const code = 'const c = await import(process.argv[1]); process.stdout.write(c.TOOL_HOME);';
  const url = pathToFileURL(path.join(link, 'src', 'config.js')).href;
  const r = spawnSync(process.execPath, ['--preserve-symlinks', '--input-type=module', '-e', code, url], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fs.realpathSync(path.resolve(SRC_DIR, '..')));
});

test('roomFile：沒給名稱是 config/room.json，--room 名稱是 config/rooms/<名稱>.json', () => {
  assert.equal(roomFile(), path.join(HOME, 'config', 'room.json'));
  assert.equal(roomFile(undefined), path.join(HOME, 'config', 'room.json'));
  assert.equal(roomFile('lab'), path.join(HOME, 'config', 'rooms', 'lab.json'));
});

// ---- loadRoom ----

test('loadRoom：只有必填欄位時合併 §3.1 全部預設值，另加 file 與 roomArg', () => {
  const file = writeRoom(REQUIRED);
  assert.deepEqual(loadRoom(), { ...DEFAULTS, ...REQUIRED, file, roomArg: null });
});

test('loadRoom：avatarStyles 逐個 vendor 覆蓋預設，回傳的是複本；avatarUrlTemplate 是空字串時為 null', () => {
  writeRoom({ ...REQUIRED, avatarUrlTemplate: '', avatarStyles: { codex: 'thumbs' } });
  const room = loadRoom();
  assert.equal(room.avatarUrlTemplate, null);
  assert.deepEqual(room.avatarStyles, { ...DEFAULTS.avatarStyles, codex: 'thumbs' });
  writeRoom(REQUIRED);
  loadRoom().avatarStyles.claude = 'changed';
  assert.equal(loadRoom().avatarStyles.claude, 'bottts', '改一份不影響下一次 loadRoom');
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
  assert.deepEqual(loadRoom(), { ...DEFAULTS, ...custom, file, roomArg: null });
});

for (const key of Object.keys(REQUIRED)) {
  test(`loadRoom：缺必填欄位 ${key} 丟 UserError`, () => {
    const room = { ...REQUIRED };
    delete room[key];
    writeRoom(room);
    assert.throws(() => loadRoom(), isUserError);
  });
}

test('loadRoom：ID 不是純數字字串丟 UserError（JSON 數字超過 2^53 會失準）', () => {
  for (const [key, value] of [
    ['guildId', 1550401210861756457],
    ['channelId', '15623O4076115611710'],
    ['moderatorUserId', '<@816128017460887562>'],
    ['channelId', ' 1562304076115611710'],
  ]) {
    writeRoom({ ...REQUIRED, [key]: value });
    assert.throws(() => loadRoom(), isUserError, `${key}=${JSON.stringify(value)}`);
  }
});

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
  assert.equal(room.roomArg, 'lab');
});

test('loadRoom：--room 的設定檔也檢查必填欄位', () => {
  writeRoom({ guildId: '1' }, path.join(HOME, 'config', 'rooms', 'broken.json'));
  assert.throws(() => loadRoom('broken'), isUserError);
});

// 設定檔不存在、缺 token 都是設定錯誤：§6.1 規定結束碼 2，對應 §7.5 的 UserError。
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
  assert.equal(c.TOOL_HOME, none);
  assert.deepEqual(c.loadEnv(), {});
});

// ---- getToken ----

test('getToken：環境變數優先於 .env', () => {
  fs.writeFileSync(path.join(HOME, '.env'), 'DISCORD_BOT_TOKEN=from-file\n');
  process.env.DISCORD_BOT_TOKEN = 'from-env';
  try {
    // 不用 assert.equal：失敗時不要把 token 印出來（§9）。
    assert.ok(getToken() === 'from-env', '沒有優先用環境變數的 token');
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
  }
});

test('getToken：沒有環境變數時讀 <工具目錄>/.env', () => {
  fs.writeFileSync(path.join(HOME, '.env'), '# 註解\nDISCORD_BOT_TOKEN="from-file"\n');
  assert.ok(getToken() === 'from-file', '沒有讀到 .env 的 token');
});

test('getToken：兩邊都沒有時丟 UserError', async () => {
  const empty = path.join(tmpRoot, 'empty-home');
  fs.mkdirSync(empty, { recursive: true });
  const c = await importWith({ AGENTCHAT_HOME: empty, DISCORD_BOT_TOKEN: undefined }, 'no-token');
  assert.equal(c.TOOL_HOME, empty);
  assert.throws(() => c.getToken(), isUserError);
});

test('getToken：.env 裡 token 是空值時也丟 UserError', async () => {
  const blank = path.join(tmpRoot, 'blank-home');
  fs.mkdirSync(blank, { recursive: true });
  fs.writeFileSync(path.join(blank, '.env'), 'DISCORD_BOT_TOKEN=\n');
  const c = await importWith({ AGENTCHAT_HOME: blank, DISCORD_BOT_TOKEN: undefined }, 'blank-token');
  assert.equal(c.TOOL_HOME, blank);
  assert.throws(() => c.getToken(), isUserError);
});
