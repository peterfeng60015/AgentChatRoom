// src/state.js 的單元測試（SPEC §3.3、§5.1、§7.3）。
// STATE_DIR 在模組載入時決定，所以先把 AGENTCHAT_STATE_DIR 指到暫存目錄再動態 import。
// 不碰真正的 ~/.agentchat 有三道防護：HOME 也指到暫存、載入後 STATE_DIR 不對就整檔中止、頻道 ID 用假的，
// 這樣就算實作退化成不讀環境變數，也不會覆寫真實的 agent 狀態或 webhook 快取。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-state-')));
const STATE = path.join(tmpRoot, 'state');

const FAKE_HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(FAKE_HOME, { recursive: true });

const savedEnv = { stateDir: process.env.AGENTCHAT_STATE_DIR, home: process.env.HOME, userProfile: process.env.USERPROFILE };
process.env.AGENTCHAT_STATE_DIR = STATE;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const restoreEnv = () => {
  for (const [key, value] of [['AGENTCHAT_STATE_DIR', savedEnv.stateDir], ['HOME', savedEnv.home], ['USERPROFILE', savedEnv.userProfile]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const STATE_URL = pathToFileURL(path.join(SRC_DIR, 'state.js')).href;
const state = await import(STATE_URL);
if (state.STATE_DIR !== STATE) {
  // 模組丟錯時 after() 不會執行，所以先自己清掉暫存目錄、還原環境變數。
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  throw new Error(`STATE_DIR 沒有讀 AGENTCHAT_STATE_DIR（得到 ${state.STATE_DIR}），中止整檔以免寫進真正的狀態目錄`);
}
const { loadAgent, saveAgent, newAgent, loadWebhook, saveWebhook, clearWebhook, appendLog, downloadDir } = state;

after(() => {
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 明顯是假的頻道 ID，不用 config/room.json 裡的真實頻道。
const CH = '900000000000000001';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const mode = (file) => fs.statSync(file).mode & 0o777;

// §5.1 列出的全部欄位。
const STATE_FIELDS = [
  'version', 'name', 'vendor', 'model', 'channelId',
  'role', 'task', 'branch', 'isolation', 'files', 'assigned', 'assignMessageId', 'assignBody', 'phaseBeforeStop',
  'topic', 'phase', 'cursor', 'discussRound', 'discussLimit', 'ownMessageIds', 'pendingQuestionId',
  'joinedAt', 'lastActivityAt', 'lastProgressAt', 'workStartedAt', 'emptyWaitSince', 'left',
];
const TIME_FIELDS = ['joinedAt', 'lastActivityAt', 'lastProgressAt', 'workStartedAt', 'emptyWaitSince'];

const fresh = (over = {}) =>
  newAgent({ name: 'claude-1', vendor: 'claude', model: 'claude-opus-5-5', channelId: CH, cursor: '1300000000000000000', ...over });

test('STATE_DIR 讀 AGENTCHAT_STATE_DIR', () => {
  assert.equal(state.STATE_DIR, STATE);
});

test('沒有 AGENTCHAT_STATE_DIR 時，STATE_DIR 預設是 ~/.agentchat（只比路徑，不寫檔）', async () => {
  delete process.env.AGENTCHAT_STATE_DIR;
  try {
    const s = await import(`${STATE_URL}?default-dir`);
    assert.equal(s.STATE_DIR, path.join(FAKE_HOME, '.agentchat'));
    assert.equal(fs.existsSync(path.join(FAKE_HOME, '.agentchat')), false, '載入模組不應建立狀態目錄');
  } finally {
    process.env.AGENTCHAT_STATE_DIR = STATE;
  }
});

// ---- newAgent（§5.1） ----

test('newAgent：§5.1 的欄位齊全', () => {
  const s = fresh();
  for (const key of STATE_FIELDS) assert.ok(Object.hasOwn(s, key), `缺少 ${key}`);
});

test('newAgent：身分與游標照參數', () => {
  const s = fresh();
  assert.equal(s.version, 1);
  assert.equal(s.name, 'claude-1');
  assert.equal(s.vendor, 'claude');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.channelId, CH);
  assert.equal(s.cursor, '1300000000000000000');
});

test('newAgent：初始值（沒有分工、未指派、沒有議題、lobby、計數 0）', () => {
  const s = fresh();
  for (const key of [
    'role', 'task', 'branch', 'isolation', 'files', 'assignMessageId', 'assignBody', 'phaseBeforeStop',
    'topic', 'discussLimit', 'pendingQuestionId',
  ]) {
    assert.equal(s[key], null, key);
  }
  assert.equal(s.assigned, false);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.discussRound, 0);
  assert.deepEqual(s.ownMessageIds, []);
  assert.equal(s.left, false);
});

test('newAgent：時間戳是 ISO 字串或 null，emptyWaitSince 初始為 null', () => {
  const s = fresh();
  for (const key of TIME_FIELDS) {
    assert.ok(s[key] === null || (typeof s[key] === 'string' && ISO_RE.test(s[key])), `${key}=${s[key]}`);
  }
  assert.equal(s.emptyWaitSince, null);
  assert.equal(s.lastProgressAt, null);
  assert.equal(s.workStartedAt, null);
  assert.ok(ISO_RE.test(s.joinedAt));
});

test('newAgent：每次回傳新的物件（ownMessageIds 不共用）', () => {
  const a = fresh();
  const b = fresh({ name: 'claude-2' });
  a.ownMessageIds.push('1');
  assert.deepEqual(b.ownMessageIds, []);
});

// ---- saveAgent / loadAgent ----

test('saveAgent / loadAgent 來回一致，存在 agents/<channelId>/<名稱>.json', () => {
  const s = fresh();
  s.phase = 'discussion';
  s.role = '前端';
  s.ownMessageIds = ['1', '2'];
  s.topic = { id: '9', title: '議題', fields: { repo: '/x' }, body: '說明' };
  saveAgent(s);
  const file = path.join(STATE, 'agents', CH, 'claude-1.json');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), s);
  assert.deepEqual(loadAgent(CH, 'claude-1'), s);
});

test('saveAgent 覆寫既有狀態，目錄裡不留暫存檔（含 . 開頭的隱藏檔）', () => {
  const ch = '900000000000000003';
  const s = fresh({ name: 'claude-3', channelId: ch });
  saveAgent(s);
  s.phase = 'work';
  s.discussRound = 2;
  saveAgent(s);
  saveAgent(s);
  assert.equal(loadAgent(ch, 'claude-3').phase, 'work');
  assert.deepEqual(fs.readdirSync(path.join(STATE, 'agents', ch)), ['claude-3.json']);
});

test('saveAgent 原子寫入：先寫同目錄的暫存檔，再改名成狀態檔', () => {
  const s = fresh({ name: 'atomic-1' });
  const target = path.join(STATE, 'agents', CH, 'atomic-1.json');
  const renames = [];
  const directWrites = [];
  const orig = { renameSync: fs.renameSync, writeFileSync: fs.writeFileSync };
  // 改 node:fs 的預設匯出並同步到具名匯出，不論 state.js 用哪種 import 都攔得到。
  fs.renameSync = (from, to) => {
    renames.push([String(from), String(to)]);
    return orig.renameSync(from, to);
  };
  fs.writeFileSync = (file, ...rest) => {
    if (path.resolve(String(file)) === target) directWrites.push(String(file));
    return orig.writeFileSync(file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    saveAgent(s);
  } finally {
    Object.assign(fs, orig);
    syncBuiltinESMExports();
  }
  const final = renames.find(([, to]) => path.resolve(to) === target);
  assert.ok(final, `沒有改名成狀態檔：${JSON.stringify(renames)}`);
  assert.equal(path.dirname(path.resolve(final[0])), path.dirname(target), '暫存檔要在同一個目錄才能原子改名');
  assert.deepEqual(directWrites, [], '不應直接寫入狀態檔');
  assert.deepEqual(loadAgent(CH, 'atomic-1'), s);
});

test('loadAgent：狀態檔不存在回 null', () => {
  assert.equal(loadAgent(CH, 'nobody'), null);
  assert.equal(loadAgent('1', 'claude-1'), null);
});

test('不同頻道的同名 agent 分開存', () => {
  const a = fresh({ name: 'twin', channelId: '111' });
  const b = fresh({ name: 'twin', channelId: '222' });
  b.role = '後端';
  saveAgent(a);
  saveAgent(b);
  assert.equal(loadAgent('111', 'twin').role, null);
  assert.equal(loadAgent('222', 'twin').role, '後端');
});

// ---- webhook 快取（§3.3） ----

test('saveWebhook / loadWebhook 來回一致，檔案權限 0600', () => {
  const hook = { id: '7000', token: 'secret-token' };
  saveWebhook(CH, hook);
  const file = path.join(STATE, 'webhooks', `${CH}.json`);
  assert.equal(mode(file), 0o600);
  assert.deepEqual(loadWebhook(CH), hook);
});

test('saveWebhook 覆寫權限較寬的既有檔案後仍是 0600', () => {
  const ch = '333';
  const file = path.join(STATE, 'webhooks', `${ch}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);
  saveWebhook(ch, { id: '1', token: 't' });
  assert.equal(mode(file), 0o600);
  assert.deepEqual(loadWebhook(ch), { id: '1', token: 't' });
});

test('clearWebhook 刪除快取；之後 loadWebhook 回 null；不存在時不丟錯', () => {
  saveWebhook('444', { id: '1', token: 't' });
  clearWebhook('444');
  assert.equal(loadWebhook('444'), null);
  assert.doesNotThrow(() => clearWebhook('444'));
  assert.equal(loadWebhook('never-saved'), null);
});

// ---- appendLog、downloadDir ----

test('appendLog：logs/<channelId>.jsonl 一行一筆 JSON，依序累加', () => {
  appendLog(CH, { dir: 'out', id: '1', tag: 'JOIN' });
  appendLog(CH, { dir: 'in', id: '2', tag: 'TOPIC', text: '多行\n內容' });
  const file = path.join(STATE, 'logs', `${CH}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert.equal(a.id, '1');
  assert.equal(a.tag, 'JOIN');
  assert.equal(b.id, '2');
  assert.equal(b.text, '多行\n內容');
});

test('downloadDir：downloads/<channelId>/<messageId>', () => {
  assert.equal(downloadDir(CH, '555'), path.join(STATE, 'downloads', CH, '555'));
});
