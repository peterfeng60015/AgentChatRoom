// clear 與 doctor 處理專屬 webhook 的邊界情況（SPEC §6.3 clear 第 6～8 步、doctor 第 8a、9 項）。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(env, name = 'a.png') {
  const file = path.join(env.root, name);
  fs.writeFileSync(file, Buffer.concat([PNG_HEAD, Buffer.from('x'.repeat(20))]));
  return file;
}

const hooksDir = (env) => path.join(env.stateDir, 'webhooks', env.room.channelId);
const knownFile = (env) => path.join(env.stateDir, 'webhooks', `${env.room.channelId}.known.json`);
const sharedFile = (env) => path.join(env.stateDir, 'webhooks', `${env.room.channelId}.json`);
const hookNamed = (env, name) => env.mock.webhooks.find((w) => w.name === name);

function assertNoTokens(env, r) {
  for (const w of env.mock.webhooks) {
    assert.ok(!r.stdout.includes(w.token) && !r.stderr.includes(w.token), `輸出不能有 ${w.name} 的 token`);
  }
}

// 進房並設好 claude-1 的專屬 webhook，也寫出辨識快取。
async function withAvatar(env) {
  await env.join('claude-1');
  const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env)]);
  assert.equal(r.code, 0, r.stderr);
  fs.writeFileSync(knownFile(env), JSON.stringify({ room: [], other: [] }));
}

describe('clear：專屬 webhook', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('名稱比對精確：只刪 <webhookName>- 開頭的，共用與名稱相近的別人的都保留；輸出不含 token', async () => {
    env = await setup();
    await withAvatar(env);
    const keep = ['agentchatx', 'agentchat_bot', 'my-agentchat-1', 'AGENTCHAT-gemini-1', 'agentchat'].map((name) =>
      name === 'agentchat' ? hookNamed(env, 'agentchat') : env.mock.addWebhook({ name }),
    );
    const remote = env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    const own = hookNamed(env, 'agentchat-claude-1');
    const tokens = env.mock.webhooks.map((w) => w.token);

    const r = await env.run(['clear', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.webhooksDeleted, 2);
    assert.equal(out.webhookError, null);
    assert.deepEqual(env.mock.webhookDeletes.sort(), [own.id, remote.id].sort());
    assert.deepEqual(env.mock.webhooks.map((w) => w.id).sort(), keep.map((w) => w.id).sort());
    for (const t of tokens) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t), '輸出不含 token');
    assert.equal(fs.existsSync(hooksDir(env)), false);
    assert.equal(fs.existsSync(knownFile(env)), false);
    assert.ok(fs.existsSync(sharedFile(env)), '共用 webhook 快取保留');
  });

  test('文字輸出列出刪掉的專屬 webhook 個數', async () => {
    env = await setup();
    await withAvatar(env);
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /已刪除頻道裡 1 個 agent 專屬 webhook（共用 webhook 保留）/);
    assert.doesNotMatch(r.stdout, /警告：刪除專屬 webhook/);
  });

  test('其中一個刪除失敗：其他照刪，結束碼不變，警告附原因與已刪個數，本機快取照刪', async () => {
    env = await setup();
    await withAvatar(env);
    const a = env.mock.addWebhook({ name: 'agentchat-a' });
    const b = env.mock.addWebhook({ name: 'agentchat-b' });
    env.mock.fail({ method: 'DELETE', path: `/webhooks/${a.id}`, status: 400, body: { message: 'Bad thing', code: 0 } });

    const r = await env.run(['clear', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.equal(out.webhooksDeleted, 2);
    assert.match(out.webhookError, /有 1 個專屬 webhook 刪除失敗/);
    assert.ok(hookNamed(env, 'agentchat-a'), 'a 刪不掉');
    assert.ok(!hookNamed(env, 'agentchat-b') && !hookNamed(env, 'agentchat-claude-1'), '其他照刪');
    assert.ok(env.mock.webhookDeletes.includes(b.id));
    assert.equal(fs.existsSync(hooksDir(env)), false);
    assert.equal(fs.existsSync(knownFile(env)), false);
    assertNoTokens(env, r);
  });

  test('刪除時回 404 算已不存在，不算失敗也不算刪掉', async () => {
    env = await setup();
    await withAvatar(env);
    const gone = env.mock.addWebhook({ name: 'agentchat-gone' });
    env.mock.fail({ method: 'DELETE', path: `/webhooks/${gone.id}`, status: 404, body: { message: 'Unknown Webhook', code: 10015 } });
    const r = await env.run(['clear', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.webhooksDeleted, 1);
    assert.equal(out.webhookError, null);
  });

  test('查清單失敗（沒有管理 Webhook）：文字警告附原因與 0 個，--json 有 webhookError，本機快取照刪', async () => {
    env = await setup();
    await withAvatar(env);
    env.mock.config.webhookPermission = false;
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /警告：刪除專屬 webhook 沒有完成（查頻道的 webhook 清單失敗：bot 沒有「管理 Webhook」權限），已刪除 0 個/);
    assert.doesNotMatch(r.stdout, /已刪除頻道裡 0 個/);
    assert.ok(hookNamed(env, 'agentchat-claude-1'));
    assert.equal(fs.existsSync(hooksDir(env)), false);
    assert.equal(fs.existsSync(knownFile(env)), false);
    assert.ok(fs.existsSync(sharedFile(env)));
    assertNoTokens(env, r);

    const j = await env.run(['clear', '--yes', '--json']);
    assert.equal(j.code, 0, j.stderr);
    const out = j.json();
    assert.equal(out.webhooksDeleted, 0);
    assert.match(out.webhookError, /管理 Webhook/);
  });

  test('刪訊息中止（403）時不刪 webhook、不清本機快取', async () => {
    env = await setup();
    await withAvatar(env);
    env.mock.fail({ method: 'DELETE', path: /^\/channels\/\d+\/messages\/\d+$/, status: 403, body: { message: 'Missing Permissions', code: 50013 } });
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /本機狀態沒有清除/);
    assert.deepEqual(env.mock.webhookDeletes, []);
    assert.ok(hookNamed(env, 'agentchat-claude-1'));
    assert.ok(fs.existsSync(hooksDir(env)));
    assert.ok(fs.existsSync(knownFile(env)));
  });

  test('沒帶 --yes 又不是終端機：中止，不碰 webhook', async () => {
    env = await setup();
    await withAvatar(env);
    const r = await env.run(['clear']);
    assert.equal(r.code, 2);
    assert.deepEqual(env.mock.webhookDeletes, []);
    assert.ok(fs.existsSync(hooksDir(env)));
  });
});

describe('doctor：webhook 數量與 --send-test', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('只算名稱精確符合的：共用 1、專屬 2，名稱相近的不算本工具的；12 個 OK', async () => {
    env = await setup();
    await withAvatar(env);
    env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    for (const name of ['agentchatx', 'agentchat_bot', 'my-agentchat', 'AGENTCHAT-x']) env.mock.addWebhook({ name });
    for (let i = 0; i < 5; i++) env.mock.addWebhook({ name: `other-${i}` });
    const r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[OK\] webhook 數量：頻道有 12\/15 個 webhook（本工具的共用 1 個、agent 專屬 2 個）/);
    assertNoTokens(env, r);
  });

  test('13 個以上 WARN，附提示', async () => {
    env = await setup();
    await withAvatar(env);
    for (let i = 0; i < 12; i++) env.mock.addWebhook({ name: `x-${i}` });
    const r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[WARN\] webhook 數量：頻道有 14\/15 個 webhook（本工具的共用 1 個、agent 專屬 1 個），接近上限.*agentchat clear/);
  });

  test('查清單失敗只 WARN，不 FAIL', async () => {
    env = await setup();
    await env.join('claude-1'); // 共用 webhook 快取有效，第 8 項不必查清單
    env.mock.fail({ method: 'GET', path: `/channels/${env.room.channelId}/webhooks`, status: 403, body: { message: 'Missing Permissions', code: 50013 } });
    const r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[OK\] webhook：/);
    assert.match(r.stdout, /\[WARN\] webhook 數量：無法取得頻道的 webhook 清單/);
  });

  test('第 8 項沒通過時不做 8a', async () => {
    env = await setup();
    env.mock.config.webhookPermission = false;
    const r = await env.run(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\[FAIL\] webhook：/);
    assert.doesNotMatch(r.stdout, /webhook 數量/);
  });

  test('--send-test 用共用 webhook，不用 agent 的專屬 webhook，也不印 token', async () => {
    env = await setup();
    await withAvatar(env);
    const shared = hookNamed(env, 'agentchat');
    const r = await env.run(['doctor', '--as', 'claude-1', '--send-test']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[OK\] 測試訊息：已送出/);
    const msg = env.mock.lastMessage();
    assert.equal(msg.content, '[INFO] doctor 測試');
    assert.equal(msg.webhook_id, shared.id);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, undefined);
    assertNoTokens(env, r);
  });
});
