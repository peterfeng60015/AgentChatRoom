// src/state.js 的專屬 webhook 快取與辨識快取（SPEC §3.3、§4.5、§7.3）。
// STATE_DIR 在模組載入時決定：先把 AGENTCHAT_STATE_DIR 與 HOME 指到暫存目錄再動態 import，
// 載入後 STATE_DIR 不對就整檔中止，絕不碰真正的 ~/.agentchat。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-state-avatar-')));
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

const state = await import(pathToFileURL(path.join(SRC_DIR, 'state.js')).href);
if (state.STATE_DIR !== STATE) {
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  throw new Error(`STATE_DIR 沒有讀 AGENTCHAT_STATE_DIR（得到 ${state.STATE_DIR}），中止整檔以免寫進真正的狀態目錄`);
}
const {
  loadAgentWebhook,
  saveAgentWebhook,
  clearAgentWebhook,
  listAgentWebhooks,
  clearAgentWebhooks,
  loadKnownWebhooks,
  saveKnownWebhooks,
  clearKnownWebhooks,
  saveWebhook,
  loadWebhook,
} = state;

after(() => {
  restoreEnv();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 明顯是假的頻道 ID。
const CH = '900000000000000002';
const CH2 = '900000000000000003';
const dir = (ch = CH) => path.join(STATE, 'webhooks', ch);
const hook = (id, agent) => ({ id, token: `tok-${id}-${'k'.repeat(40)}`, channelId: CH, name: `agentchat-${agent.toLowerCase()}`, agent });

test('saveAgentWebhook：路徑 webhooks/<channelId>/<名稱小寫>.json、0600；load 不分大小寫', () => {
  const h = hook('111', 'Claude-1');
  saveAgentWebhook(CH, 'Claude-1', h);
  const file = path.join(dir(), 'claude-1.json');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(dir()), ['claude-1.json'], '沒有留下暫存檔');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadAgentWebhook(CH, 'CLAUDE-1'), h);
  assert.deepEqual(loadAgentWebhook(CH, 'claude-1'), h);
  assert.equal(loadAgentWebhook(CH2, 'claude-1'), null, '別的頻道沒有');

  // 覆寫
  const h2 = hook('112', 'claude-1');
  saveAgentWebhook(CH, 'claude-1', h2);
  assert.equal(loadAgentWebhook(CH, 'Claude-1').id, '112');

  clearAgentWebhook(CH, 'CLAUDE-1');
  assert.equal(loadAgentWebhook(CH, 'claude-1'), null);
  clearAgentWebhook(CH, 'claude-1'); // 不存在也不丟錯
});

test('loadAgentWebhook：壞掉、缺 id 或 token、型別不對都當作沒有快取，不丟錯', () => {
  fs.mkdirSync(dir(), { recursive: true });
  const write = (name, text) => fs.writeFileSync(path.join(dir(), `${name}.json`), text);
  write('broken', '{"id":"1","token":"secret-should-not-leak');
  assert.equal(loadAgentWebhook(CH, 'broken'), null);
  write('notoken', JSON.stringify({ id: '1' }));
  assert.equal(loadAgentWebhook(CH, 'notoken'), null);
  write('noid', JSON.stringify({ token: 'x'.repeat(20) }));
  assert.equal(loadAgentWebhook(CH, 'noid'), null);
  write('numeric', JSON.stringify({ id: 1, token: 2 }));
  assert.equal(loadAgentWebhook(CH, 'numeric'), null);
  write('null', 'null');
  assert.equal(loadAgentWebhook(CH, 'null'), null);
  clearAgentWebhooks(CH);
});

test('listAgentWebhooks：只列有效的 .json 快取；目錄不存在回空陣列；clearAgentWebhooks 整個目錄刪掉', () => {
  assert.deepEqual(listAgentWebhooks(CH), []);
  saveAgentWebhook(CH, 'claude-1', hook('201', 'claude-1'));
  saveAgentWebhook(CH, 'Gemini-1', hook('202', 'Gemini-1'));
  saveAgentWebhook(CH2, 'codex-1', { ...hook('203', 'codex-1'), channelId: CH2 });
  fs.writeFileSync(path.join(dir(), 'broken.json'), '{');
  fs.writeFileSync(path.join(dir(), 'claude-2.json.123.abcd.tmp'), JSON.stringify(hook('204', 'claude-2')));
  fs.writeFileSync(path.join(dir(), 'notes.txt'), 'x');

  const ids = listAgentWebhooks(CH).map((h) => h.id).sort();
  assert.deepEqual(ids, ['201', '202']);

  clearAgentWebhooks(CH);
  assert.equal(fs.existsSync(dir()), false);
  assert.deepEqual(listAgentWebhooks(CH), []);
  assert.equal(listAgentWebhooks(CH2).length, 1, '別的頻道不受影響');
  clearAgentWebhooks(CH); // 不存在也不丟錯
  clearAgentWebhooks(CH2);
});

test('clearAgentWebhooks 不動共用 webhook 快取與辨識快取', () => {
  saveWebhook(CH, { id: '300', token: 'shared-token-xxxxxxxxxxxx' });
  saveKnownWebhooks(CH, { room: ['300'], other: [] });
  saveAgentWebhook(CH, 'claude-1', hook('301', 'claude-1'));
  clearAgentWebhooks(CH);
  assert.equal(loadWebhook(CH).id, '300');
  assert.deepEqual(loadKnownWebhooks(CH).room, ['300']);
  clearKnownWebhooks(CH);
});

test('辨識快取：寫入去重、不含 token；壞掉或不存在回空的；只收字串 ID', () => {
  assert.deepEqual(loadKnownWebhooks(CH), { room: [], other: [] });
  saveKnownWebhooks(CH, { room: ['1', '2', '1'], other: new Set(['9', '9']) });
  const file = path.join(STATE, 'webhooks', `${CH}.known.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { room: ['1', '2'], other: ['9'] });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('token'));
  assert.deepEqual(loadKnownWebhooks(CH), { room: ['1', '2'], other: ['9'] });

  fs.writeFileSync(file, JSON.stringify({ room: ['1', 2, null], other: 'x' }));
  assert.deepEqual(loadKnownWebhooks(CH), { room: ['1'], other: [] });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadKnownWebhooks(CH), { room: [], other: [] });

  clearKnownWebhooks(CH);
  assert.equal(fs.existsSync(file), false);
  clearKnownWebhooks(CH); // 不存在也不丟錯
});
