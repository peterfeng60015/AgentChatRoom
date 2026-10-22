// agent 自畫頭像（SPEC §6.3 avatar、§6.2 專屬 webhook、§4.5 本房 webhook 辨識、§6.3 clear 第 6 步、doctor 8a）。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';
import { imageFormat } from '../../src/commands/avatar.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DICEBEAR = 'https://api.dicebear.com/10.x/bottts/png?seed=claude-1&size=128';

function writeImage(env, name, data) {
  const file = path.join(env.root, name);
  fs.writeFileSync(file, data);
  return file;
}

const png = (env, name = 'a.png', fill = 'x') => writeImage(env, name, Buffer.concat([PNG_HEAD, Buffer.from(fill.repeat(20))]));
const dataUri = (file, mime = 'image/png') => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
const hookFile = (env, name) => path.join(env.stateDir, 'webhooks', env.room.channelId, `${name}.json`);
const ownHook = (env, name) => env.mock.webhooks.find((w) => w.name === `agentchat-${name}`);
const webhookListCalls = (env) => env.mock.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/webhooks')).length;

describe('avatar：建立、更新、失效重建', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('第一次建立專屬 webhook（帶 data URI 頭像），快取 0600、不印 token；再執行改用 PATCH 更新', async () => {
    env = await setup();
    await env.join('Claude-1');
    const file = png(env);
    const r = await env.run(['avatar', '--as', 'Claude-1', '--file', file]);
    assert.equal(r.code, 0, r.stderr);
    const hook = ownHook(env, 'claude-1');
    assert.ok(hook, '頻道裡有 agentchat-claude-1');
    assert.equal(hook.avatar, dataUri(file));
    assert.match(r.stdout, /建立新的專屬 webhook，agentchat-claude-1/);
    assert.ok(!r.stdout.includes(hook.token) && !r.stderr.includes(hook.token), '不印 token');
    const cache = JSON.parse(fs.readFileSync(hookFile(env, 'claude-1'), 'utf8'));
    assert.equal(cache.id, hook.id);
    assert.equal(cache.token, hook.token);
    assert.equal(cache.agent, 'Claude-1');
    assert.equal(fs.statSync(hookFile(env, 'claude-1')).mode & 0o777, 0o600);

    const count = env.mock.webhooks.length;
    const file2 = png(env, 'b.png', 'y');
    const j = await env.run(['avatar', '--as', 'claude-1', '--file', file2, '--json']);
    assert.equal(j.code, 0, j.stderr);
    const out = j.json();
    assert.equal(out.source, 'updated');
    assert.equal(out.webhook.id, hook.id);
    assert.equal(out.format, 'png');
    assert.equal(out.webhook.token, undefined);
    assert.ok(!j.stdout.includes(hook.token));
    assert.equal(env.mock.webhooks.length, count, '沒有多建 webhook');
    assert.equal(hook.avatar, dataUri(file2));
    assert.ok(env.mock.requests.some((q) => q.method === 'PATCH' && q.path === `/api/v10/webhooks/${hook.id}/${hook.token}` && q.auth === null));
  });

  test('快取的 webhook 被刪掉時重建；快取不見但頻道裡有同名的就沿用', async () => {
    env = await setup();
    await env.join('claude-1');
    const file = png(env);
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', file])).code, 0);
    const old = ownHook(env, 'claude-1');
    env.mock.webhooks.splice(env.mock.webhooks.indexOf(old), 1);

    const r = await env.run(['avatar', '--as', 'claude-1', '--file', file, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().source, 'created');
    const rebuilt = ownHook(env, 'claude-1');
    assert.notEqual(rebuilt.id, old.id);
    assert.equal(JSON.parse(fs.readFileSync(hookFile(env, 'claude-1'), 'utf8')).id, rebuilt.id);

    fs.rmSync(hookFile(env, 'claude-1'));
    const f = await env.run(['avatar', '--as', 'claude-1', '--file', file, '--json']);
    assert.equal(f.code, 0, f.stderr);
    assert.equal(f.json().source, 'found');
    assert.equal(f.json().webhook.id, rebuilt.id);
    assert.equal(env.mock.webhooks.filter((w) => w.name === 'agentchat-claude-1').length, 1);
  });

  test('達到 15 個 webhook 上限、沒有管理 Webhook 權限時，說明原因（結束碼 1）', async () => {
    env = await setup();
    await env.join('claude-1');
    for (let i = 0; i < 14; i++) env.mock.addWebhook({ name: `other-${i}` });
    const file = png(env);
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /上限 15 個/);
    assert.match(r.stderr, /agentchat clear/);
    await env.close();

    env = await setup();
    await env.join('claude-1');
    env.mock.config.webhookPermission = false;
    const p = await env.run(['avatar', '--as', 'claude-1', '--file', png(env)]);
    assert.equal(p.code, 1);
    assert.match(p.stderr, /管理 Webhook/);
  });
});

describe('avatar：圖檔檢查與參數', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('看檔頭：PNG、JPEG、GIF 接受；其他（含 SVG、空檔、超過 8 MB、狀態目錄裡的檔）拒絕', async () => {
    env = await setup();
    await env.join('claude-1');
    const ok = async (file, format, mime) => {
      const r = await env.run(['avatar', '--as', 'claude-1', '--file', file, '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json().format, format);
      assert.equal(ownHook(env, 'claude-1').avatar, dataUri(file, mime));
    };
    await ok(writeImage(env, 'p.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), 'jpeg', 'image/jpeg');
    await ok(writeImage(env, 'p.gif', Buffer.from('GIF89a-gif-data')), 'gif', 'image/gif');
    await ok(writeImage(env, 'not-png-ext.dat', Buffer.concat([PNG_HEAD, Buffer.from('z')])), 'png', 'image/png');

    const bad = async (file, re) => {
      const before = env.mock.requests.length;
      const r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
      assert.equal(r.code, 2, `${file}: ${r.stderr}`);
      assert.match(r.stderr, re);
      assert.equal(env.mock.requests.length, before, '沒有打 API');
    };
    await bad(writeImage(env, 'a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'), /不是 PNG、JPEG 或 GIF/);
    await bad(writeImage(env, 'fake.png', 'hello'), /不是 PNG、JPEG 或 GIF/);
    await bad(writeImage(env, 'empty.png', ''), /空的/);
    await bad(writeImage(env, 'big.png', Buffer.concat([PNG_HEAD, Buffer.alloc(8 * 1024 * 1024)])), /超過 8 MB/);
    await bad(path.join(env.root, 'nope.png'), /找不到圖檔/);
    await bad(env.root, /不是一般檔案/);
    await bad(env.agentFile('claude-1'), /狀態目錄/);
    // 含 bot token 的檔案拒絕（§9 秘密內容檢查）。
    await bad(writeImage(env, 'token.png', Buffer.concat([PNG_HEAD, Buffer.from(env.mock.config.token.padEnd(20, '-'))])), /token/);
  });

  test('沒給 --file、多餘參數是結束碼 2；還沒 join 是 2；已 leave 是 3', async () => {
    env = await setup();
    await env.join('claude-1');
    const file = png(env);
    let r = await env.run(['avatar', '--as', 'claude-1']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--file/);
    r = await env.run(['avatar', '--as', 'claude-1', file]);
    assert.equal(r.code, 2);
    r = await env.run(['avatar', '--as', 'gemini-1', '--file', file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /還沒進房/);
    assert.equal((await env.run(['leave', '--as', 'claude-1'])).code, 0);
    r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 3);
    assert.equal(ownHook(env, 'claude-1'), undefined);
  });

  test('imageFormat 只看檔頭', () => {
    assert.equal(imageFormat(Buffer.concat([PNG_HEAD, Buffer.from('x')])).format, 'png');
    assert.equal(imageFormat(Buffer.from([0xff, 0xd8, 0xff])).format, 'jpeg');
    assert.equal(imageFormat(Buffer.from('GIF87a')).format, 'gif');
    assert.equal(imageFormat(Buffer.from('GIF88a')), null);
    assert.equal(imageFormat(PNG_HEAD.subarray(0, 7)), null);
    assert.equal(imageFormat(Buffer.alloc(0)), null);
  });
});

describe('發言改走專屬 webhook', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('有專屬 webhook 時經由它發言、不帶 avatar_url，顯示名稱不變；沒有的 agent 照舊用共用 webhook 加 DiceBear', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['join', '--as', 'gemini-1', '--vendor', 'gemini'])).code, 0);
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    const own = ownHook(env, 'claude-1');
    const shared = env.mock.webhooks.find((w) => w.name === 'agentchat');
    env.patchState('claude-1', { role: '前端' });

    const r = await env.run(['post', '--as', 'claude-1', '長'.repeat(2500)]);
    assert.equal(r.code, 0, r.stderr);
    const sent = env.mock.messages.slice(-2);
    for (const m of sent) {
      assert.equal(m.webhook_id, own.id);
      assert.equal(m.author.username, '前端（claude-1）');
    }
    for (const e of env.mock.executions.slice(-2)) assert.equal(e.payload.avatar_url, undefined);

    const g = await env.run(['post', '--as', 'gemini-1', 'hi']);
    assert.equal(g.code, 0, g.stderr);
    assert.equal(env.mock.lastMessage().webhook_id, shared.id);
    assert.match(env.mock.executions.at(-1).payload.avatar_url, /pixel-art/);

    // 自己經由專屬 webhook 發的訊息認得是 self；未讀不把它算進去。
    const read = await env.run(['read', '--as', 'claude-1', '--last', '3', '--json']);
    assert.equal(read.code, 0, read.stderr);
    const kinds = read.json().messages.map((m) => [m.author, m.kind]);
    assert.deepEqual(kinds.slice(-3), [
      ['claude-1', 'self'],
      ['claude-1', 'self'],
      ['gemini-1', 'agent'],
    ]);
  });

  test('專屬 webhook 失效時改用共用 webhook 加 DiceBear 重送，刪掉快取並提示重新 avatar', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    const own = ownHook(env, 'claude-1');
    env.mock.webhooks.splice(env.mock.webhooks.indexOf(own), 1);
    const before = env.mock.messages.length;

    const r = await env.run(['post', '--as', 'claude-1', 'hi', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().agentWebhookLost, true);
    assert.equal(env.mock.messages.length, before + 1, '只送出一則');
    assert.equal(env.mock.lastMessage().webhook_id, env.mock.webhooks.find((w) => w.name === 'agentchat').id);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, DICEBEAR);
    assert.equal(fs.existsSync(hookFile(env, 'claude-1')), false);

    const t = await env.run(['post', '--as', 'claude-1', 'again']);
    assert.equal(t.code, 0, t.stderr);
    assert.doesNotMatch(t.stdout, /專屬 webhook 已失效/, '快取已刪，之後不再提示');

    // 文字輸出的提示帶完整指令。
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    env.mock.webhooks.splice(env.mock.webhooks.indexOf(ownHook(env, 'claude-1')), 1);
    const x = await env.run(['post', '--as', 'claude-1', 'hi']);
    assert.equal(x.code, 0, x.stderr);
    assert.match(x.stdout, /專屬 webhook 已失效，改用共用 webhook 發言；要換回自己的頭像請重新執行 agentchat avatar --as claude-1 --file <圖檔>/);
  });

  test('[JOIN] 與自動 [IDLE] 也走專屬 webhook（同名重新 join 沿用頭像）', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    const own = ownHook(env, 'claude-1');
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const w = await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    assert.equal(w.code, 0, w.stderr);
    assert.match(env.mock.lastMessage().content, /^\[IDLE\]/);
    assert.equal(env.mock.lastMessage().webhook_id, own.id);
    assert.equal((await env.run(['leave', '--as', 'claude-1'])).code, 0);
    await env.join('claude-1');
    assert.match(env.mock.lastMessage().content, /^\[JOIN\]/);
    assert.equal(env.mock.lastMessage().webhook_id, own.id);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, undefined);
  });

  test('專屬 webhook 的 token 也不能送進頻道', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    const r = await env.run(['post', '--as', 'claude-1', `token ${ownHook(env, 'claude-1').token}`]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /token/);
  });
});

describe('辨識本房 webhook（§4.5）', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('別台機器 agent 的專屬 webhook 算 agent，陌生 webhook 算 bot；查過的寫進辨識快取，不重查', async () => {
    env = await setup();
    await env.join('claude-1');
    const remote = env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    const stranger = env.mock.addWebhook({ name: 'github' });
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: '後端（gemini-1）', content: '[INFO] 我在別台' });
    env.mock.addMessage({ author: 'webhook', webhookId: stranger.id, username: 'gemini-2', content: '[INFO] 假冒' });
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'claude-1', content: '[INFO] 名稱寫我' });

    const before = webhookListCalls(env);
    const w = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    assert.equal(w.code, 0, w.stderr);
    const kinds = w.json().messages.map((m) => [m.author, m.kind]);
    assert.deepEqual(kinds, [
      ['gemini-1', 'agent'],
      ['gemini-2', 'bot'],
    ]);
    assert.equal(webhookListCalls(env) - before, 1, '查了一次 webhook 清單');
    const known = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'webhooks', `${env.room.channelId}.known.json`), 'utf8'));
    assert.ok(known.room.includes(remote.id));
    assert.deepEqual(known.other, [stranger.id]);

    const again = webhookListCalls(env);
    const r = await env.run(['read', '--as', 'claude-1', '--last', '3']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /agent 後端（gemini-1）/);
    assert.match(r.stdout, /bot gemini-2/);
    assert.equal(webhookListCalls(env), again, '都在快取裡，不再查');
  });

  test('wait 等待期間才出現的專屬 webhook 也會查到（同一個 ID 只查一次）', async () => {
    env = await setup();
    await env.join('claude-1');
    const pending = env.run(['wait', '--as', 'claude-1', '--timeout', '3', '--json']);
    await new Promise((r) => setTimeout(r, 400));
    const remote = env.mock.addWebhook({ name: 'agentchat-codex-1' });
    const before = webhookListCalls(env);
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'codex-1', content: '[INFO] 新頭像' });
    const w = await pending;
    assert.equal(w.code, 0, w.stderr);
    assert.deepEqual(w.json().messages.map((m) => m.kind), ['agent']);
    assert.equal(w.json().status, 'matched');
    assert.equal(webhookListCalls(env) - before, 1);
  });

  test('查不到 webhook 清單（沒有權限）時：已知的照用，不認得的算 bot；不寫辨識快取', async () => {
    env = await setup();
    await env.join('claude-1');
    const remote = env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'gemini-1', content: 'hi' });
    env.mock.config.webhookPermission = false;
    const w = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    assert.equal(w.code, 0, w.stderr);
    assert.deepEqual(w.json().messages.map((m) => m.kind), ['bot']);
    assert.equal(fs.existsSync(path.join(env.stateDir, 'webhooks', `${env.room.channelId}.known.json`)), false);
  });

  test('查不到清單時，本機專屬 webhook 的訊息仍認得是 self；同一個不認得的 ID 在一次 wait 裡只查一次', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    env.mock.config.webhookPermission = false; // 之後的查詢都失敗，辨識快取不會記下專屬 webhook
    assert.equal((await env.run(['post', '--as', 'claude-1', '我的頭像'])).code, 0);
    const r = await env.run(['read', '--as', 'claude-1', '--last', '1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().messages.map((m) => m.kind), ['self']);

    // wait 等待期間同一個陌生 webhook 又發言：查詢失敗也不重查。
    const stranger = env.mock.addWebhook({ name: 'github' });
    const before = webhookListCalls(env);
    const pending = env.run(['wait', '--as', 'claude-1', '--timeout', '2', '--until', 'moderator']);
    env.mock.addMessage({ author: 'webhook', webhookId: stranger.id, username: 'ci', content: 'build 1' });
    await new Promise((res) => setTimeout(res, 800));
    env.mock.addMessage({ author: 'webhook', webhookId: stranger.id, username: 'ci', content: 'build 2' });
    const w = await pending;
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /build 2/);
    assert.equal(webhookListCalls(env) - before, 1, '同一個 ID 只查一次');
  });

  test('join 的名稱衝突也看別台機器的專屬 webhook', async () => {
    env = await setup();
    const remote = env.mock.addWebhook({ name: 'agentchat-codex-1' });
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: '前端（Codex-1）', content: '[INFO] 我還在' });
    const r = await env.run(['join', '--as', 'codex-1', '--vendor', 'codex']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /24 小時內有人用過/);
    // 陌生 webhook 用同名不算衝突。
    const stranger = env.mock.addWebhook({ name: 'github' });
    env.mock.addMessage({ author: 'webhook', webhookId: stranger.id, username: 'gemini-1', content: 'hi' });
    assert.equal((await env.run(['join', '--as', 'gemini-1', '--vendor', 'gemini'])).code, 0);
  });
});

describe('clear 與 doctor', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('clear 刪掉頻道裡的專屬 webhook（含別台機器的）與本機快取，共用 webhook 保留', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    const remote = env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    const stranger = env.mock.addWebhook({ name: 'github' });
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'gemini-1', content: 'hi' });
    assert.equal((await env.run(['read', '--as', 'claude-1'])).code, 0); // 寫出辨識快取
    const shared = env.mock.webhooks.find((w) => w.name === 'agentchat');
    const own = ownHook(env, 'claude-1');

    const r = await env.run(['clear', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.webhooksDeleted, 2);
    assert.equal(out.webhookError, null);
    assert.deepEqual(env.mock.webhookDeletes.sort(), [own.id, remote.id].sort());
    assert.deepEqual(env.mock.webhooks.map((w) => w.id).sort(), [shared.id, stranger.id].sort());
    assert.equal(fs.existsSync(path.join(env.stateDir, 'webhooks', env.room.channelId)), false);
    assert.equal(fs.existsSync(path.join(env.stateDir, 'webhooks', `${env.room.channelId}.known.json`)), false);
    assert.ok(fs.existsSync(path.join(env.stateDir, 'webhooks', `${env.room.channelId}.json`)), '共用 webhook 快取保留');

    // 重新 join 後走共用 webhook 加 DiceBear。
    await env.join('claude-1');
    assert.equal(env.mock.lastMessage().webhook_id, shared.id);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, DICEBEAR);
  });

  test('clear 刪 webhook 失敗只警告，結束碼不變，本機快取照樣刪', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    env.mock.config.webhookPermission = false;
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /警告：刪除專屬 webhook 沒有完成/);
    assert.ok(ownHook(env, 'claude-1'), 'Discord 那邊沒刪掉');
    assert.equal(fs.existsSync(path.join(env.stateDir, 'webhooks', env.room.channelId)), false);
  });

  test('doctor 印出頻道 webhook 數量，13 個以上 WARN', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    let r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[OK\] webhook 數量：頻道有 2\/15 個 webhook（本工具的共用 1 個、agent 專屬 1 個）/);
    for (let i = 0; i < 11; i++) env.mock.addWebhook({ name: `x-${i}` });
    r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[WARN\] webhook 數量：頻道有 13\/15 個 webhook.*接近上限/);
  });
});
