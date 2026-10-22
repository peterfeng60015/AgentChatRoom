// 發言改走專屬 webhook（SPEC §6.2）與本房 webhook 辨識（§4.5）的邊界情況。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x'.repeat(20))]);
const DICEBEAR = 'https://api.dicebear.com/10.x/bottts/png?seed=claude-1&size=128';
const LOST = /專屬 webhook 已失效，改用共用 webhook 發言；要換回自己的頭像請重新執行 agentchat avatar --as claude-1 --file <圖檔>/;

const hookFile = (env, name) => path.join(env.stateDir, 'webhooks', env.room.channelId, `${name}.json`);
const knownFile = (env) => path.join(env.stateDir, 'webhooks', `${env.room.channelId}.known.json`);
const ownHook = (env, name) => env.mock.webhooks.find((w) => w.name === `agentchat-${name}`);
const sharedHook = (env) => env.mock.webhooks.find((w) => w.name === 'agentchat');
const listCalls = (env) => env.mock.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/webhooks')).length;
const ownPath = (hook) => new RegExp(`^/webhooks/${hook.id}/`);
const removeHook = (env, hook) => env.mock.webhooks.splice(env.mock.webhooks.indexOf(hook), 1);

async function withAvatar(env, name = 'claude-1') {
  await env.join(name);
  const file = path.join(env.root, `${name}.png`);
  fs.writeFileSync(file, PNG);
  const r = await env.run(['avatar', '--as', name, '--file', file]);
  assert.equal(r.code, 0, r.stderr);
  return ownHook(env, name.toLowerCase());
}

describe('切段發言途中專屬 webhook 失效', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('第二段才失效：只重送那一段（改用共用 webhook 加頭像），每段只送一次，全部記進 ownMessageIds，已送出的段仍認得是自己', async () => {
    env = await setup();
    const own = await withAvatar(env);
    // 第一段照常經由專屬 webhook 送出，第二段時它被刪掉。
    env.mock.fail({ method: 'POST', path: ownPath(own), status: 404, body: { message: 'Unknown Webhook', code: 10015 }, skip: 1 });
    const before = env.mock.messages.length;

    const r = await env.run(['post', '--as', 'claude-1', '長'.repeat(2500), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.agentWebhookLost, true);
    const n = out.ids.length;
    assert.ok(n >= 2, '切成多段');
    const sent = env.mock.messages.slice(before);
    assert.equal(sent.length, n, '每段只送一次，沒有重複');
    assert.deepEqual(sent.map((m) => m.id), out.ids);
    assert.equal(sent[0].webhook_id, own.id);
    // 失效的那一段與之後的段都改用共用 webhook 加 DiceBear。
    for (const m of sent.slice(1)) assert.equal(m.webhook_id, sharedHook(env).id);
    const execs = env.mock.executions.slice(-n);
    assert.equal(execs[0].payload.avatar_url, undefined);
    for (const e of execs.slice(1)) assert.equal(e.payload.avatar_url, DICEBEAR);
    assert.equal(fs.existsSync(hookFile(env, 'claude-1')), false, '快取已刪');
    const state = env.readState('claude-1');
    for (const id of out.ids) assert.ok(state.ownMessageIds.includes(id));

    // 專屬 webhook 真的被刪掉之後，它送出的第一段仍是本房（自己），不是 bot。
    removeHook(env, own);
    const read = await env.run(['read', '--as', 'claude-1', '--last', String(n), '--json']);
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(read.json().messages.map((m) => m.kind), Array(n).fill('self'));
    const known = JSON.parse(fs.readFileSync(knownFile(env), 'utf8'));
    assert.ok(known.room.includes(own.id));
    assert.ok(!known.other.includes(own.id));
  });

  test('改用共用 webhook 重送也失敗：已送出的段照記，訊息說明只補送剩下的部分，並附上專屬 webhook 失效的提示', async () => {
    env = await setup();
    const own = await withAvatar(env);
    const shared = sharedHook(env);
    env.mock.fail({ method: 'POST', path: ownPath(own), status: 404, body: { message: 'Unknown Webhook', code: 10015 }, skip: 1 });
    env.mock.fail({ method: 'POST', path: ownPath(shared), status: 400, body: { message: 'Bad', code: 50035 } });
    const before = env.mock.messages.length;

    const r = await env.run(['post', '--as', 'claude-1', '長'.repeat(2500)]);
    assert.equal(r.code, 1);
    const sent = env.mock.messages.slice(before);
    assert.equal(sent.length, 1);
    assert.match(r.stderr, new RegExp(`已送出 1/[0-9]+ 段：${sent[0].id}；請只補送剩下的部分`));
    assert.match(r.stderr, LOST);
    assert.ok(env.readState('claude-1').ownMessageIds.includes(sent[0].id));
    assert.equal(fs.existsSync(hookFile(env, 'claude-1')), false);

    // 下一則直接走共用 webhook，不再提示。
    const n = await env.run(['post', '--as', 'claude-1', 'hi']);
    assert.equal(n.code, 0, n.stderr);
    assert.doesNotMatch(n.stdout, /專屬 webhook 已失效/);
    assert.equal(env.mock.lastMessage().webhook_id, shared.id);
  });

  test('一段都沒送出就失敗（專屬失效、共用也失敗）：[DISCUSS] 退回預扣的輪數，錯誤訊息附提示', async () => {
    env = await setup();
    const own = await withAvatar(env);
    env.patchState('claude-1', { phase: 'discussion', assigned: true, discussRound: 0 });
    removeHook(env, own);
    env.mock.fail({ method: 'POST', path: ownPath(sharedHook(env)), status: 400, body: { message: 'Bad', code: 50035 } });
    const r = await env.run(['discuss', '--as', 'claude-1', 'hi']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, LOST);
    assert.equal(env.readState('claude-1').discussRound, 0);
  });

  test('token 失效（401）也一樣改用共用 webhook', async () => {
    env = await setup();
    const own = await withAvatar(env);
    own.token = `${own.token}-rotated`;
    const r = await env.run(['post', '--as', 'claude-1', 'hi', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().agentWebhookLost, true);
    assert.equal(env.mock.lastMessage().webhook_id, sharedHook(env).id);
  });

  test('等待回應期間 avatar 換了新的專屬 webhook：改用新的，不刪它的快取、不提示失效', async () => {
    env = await setup();
    const old = await withAvatar(env);
    removeHook(env, old);
    const fresh = env.mock.addWebhook({ name: 'agentchat-claude-1' });
    env.mock.delay({ method: 'POST', path: ownPath(old), ms: 800 });
    const pending = env.run(['post', '--as', 'claude-1', 'hi', '--json']);
    await new Promise((res) => setTimeout(res, 400));
    const cache = { id: fresh.id, token: fresh.token, channelId: env.room.channelId, name: fresh.name, agent: 'claude-1' };
    fs.writeFileSync(hookFile(env, 'claude-1'), JSON.stringify(cache));
    const r = await pending;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().agentWebhookLost, undefined);
    assert.equal(env.mock.lastMessage().webhook_id, fresh.id);
    assert.equal(JSON.parse(fs.readFileSync(hookFile(env, 'claude-1'), 'utf8')).id, fresh.id);
  });
});

describe('[JOIN]、自動 [IDLE] 遇到專屬 webhook 失效；join、leave 不動快取', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('leave 與 join --force 都保留專屬 webhook 快取，[JOIN] 照樣經由它送出', async () => {
    env = await setup();
    const own = await withAvatar(env);
    assert.equal((await env.run(['leave', '--as', 'claude-1'])).code, 0);
    assert.ok(fs.existsSync(hookFile(env, 'claude-1')));
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--force'])).code, 0);
    assert.ok(fs.existsSync(hookFile(env, 'claude-1')));
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--force'])).code, 0);
    assert.equal(env.mock.lastMessage().webhook_id, own.id);
  });

  test('join 時專屬 webhook 已失效：[JOIN] 改用共用 webhook 加頭像，輸出提示，--json 帶 agentWebhookLost', async () => {
    env = await setup();
    const own = await withAvatar(env);
    assert.equal((await env.run(['leave', '--as', 'claude-1'])).code, 0);
    removeHook(env, own);
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().agentWebhookLost, true);
    assert.match(env.mock.lastMessage().content, /^\[JOIN\]/);
    assert.equal(env.mock.lastMessage().webhook_id, sharedHook(env).id);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, DICEBEAR);
    assert.equal(fs.existsSync(hookFile(env, 'claude-1')), false);

    // 文字輸出帶 --room（有 roomArg 時）。
    await env.close();
    env = await setup();
    fs.mkdirSync(path.join(env.home, 'config', 'rooms'), { recursive: true });
    fs.copyFileSync(path.join(env.home, 'config', 'room.json'), path.join(env.home, 'config', 'rooms', 'lab.json'));
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--room', 'lab'])).code, 0);
    const file = path.join(env.root, 'a.png');
    fs.writeFileSync(file, PNG);
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--room', 'lab', '--file', file])).code, 0);
    assert.equal((await env.run(['leave', '--as', 'claude-1', '--room', 'lab'])).code, 0);
    removeHook(env, ownHook(env, 'claude-1'));
    const t = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--room', 'lab']);
    assert.equal(t.code, 0, t.stderr);
    assert.match(t.stdout, /重新執行 agentchat avatar --as claude-1 --room lab --file <圖檔>/);
  });

  test('自動 [IDLE] 時專屬 webhook 已失效：改用共用 webhook 送出，注意裡提示，--json 帶 agentWebhookLost', async () => {
    env = await setup();
    const own = await withAvatar(env);
    removeHook(env, own);
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const w = await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--json']);
    assert.equal(w.code, 0, w.stderr);
    const out = w.json();
    assert.equal(out.status, 'idle');
    assert.equal(out.agentWebhookLost, true);
    assert.ok(out.notes.some((n) => LOST.test(n)));
    assert.match(env.mock.lastMessage().content, /^\[IDLE\]/);
    assert.equal(env.mock.lastMessage().webhook_id, sharedHook(env).id);
  });
});

describe('本房 webhook 辨識（§4.5）的邊界', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('共用 webhook 被刪掉、重建之後，它以前發的訊息仍是本房（agent／self），不是 bot', async () => {
    env = await setup();
    await env.join('claude-1');
    assert.equal((await env.run(['join', '--as', 'gemini-1', '--vendor', 'gemini'])).code, 0);
    assert.equal((await env.run(['post', '--as', 'gemini-1', '舊的'])).code, 0);
    const old = sharedHook(env);
    removeHook(env, old);
    // claude-1 發言時發現共用 webhook 已失效，重新建立。
    assert.equal((await env.run(['post', '--as', 'claude-1', '新的'])).code, 0);
    assert.notEqual(sharedHook(env).id, old.id);

    const r = await env.run(['read', '--as', 'claude-1', '--last', '4', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const kinds = r.json().messages.map((m) => [m.author, m.kind]);
    assert.deepEqual(kinds, [
      ['claude-1', 'self'],
      ['gemini-1', 'agent'],
      ['gemini-1', 'agent'],
      ['claude-1', 'self'],
    ]);
  });

  test('辨識快取寫不進去時，同一個 wait 之後的輪詢仍照查到的結果判斷（不重查、不把本房 ID 當 bot）', async () => {
    env = await setup();
    await env.join('claude-1');
    // 辨識快取的位置被目錄占住：寫入一定失敗。
    fs.mkdirSync(knownFile(env), { recursive: true });
    fs.writeFileSync(path.join(knownFile(env), 'x'), '');
    const remote = env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    const before = listCalls(env);
    const pending = env.run(['wait', '--as', 'claude-1', '--timeout', '2', '--until', 'moderator', '--json']);
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'gemini-1', content: '第一則' });
    await new Promise((res) => setTimeout(res, 700));
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'gemini-1', content: '第二則' });
    const w = await pending;
    assert.equal(w.code, 0, w.stderr);
    assert.deepEqual(w.json().messages.map((m) => [m.content, m.kind]), [
      ['第一則', 'agent'],
      ['第二則', 'agent'],
    ]);
    assert.equal(listCalls(env) - before, 1, '同一個 ID 只查一次');
  });

  test('查詢失敗時不寫快取；下一個行程（新的指令）會再查，查到後補上', async () => {
    env = await setup();
    await env.join('claude-1');
    const remote = env.mock.addWebhook({ name: 'agentchat-gemini-1' });
    env.mock.addMessage({ author: 'webhook', webhookId: remote.id, username: 'gemini-1', content: 'hi' });
    env.mock.fail({ method: 'GET', path: `/channels/${env.room.channelId}/webhooks`, status: 403, body: { message: 'Missing Permissions', code: 50013 } });
    let r = await env.run(['read', '--as', 'claude-1', '--last', '1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().messages.map((m) => m.kind), ['bot']);
    assert.equal(fs.existsSync(knownFile(env)), false);
    r = await env.run(['read', '--as', 'claude-1', '--last', '1', '--json']);
    assert.deepEqual(r.json().messages.map((m) => m.kind), ['agent']);
    assert.ok(JSON.parse(fs.readFileSync(knownFile(env), 'utf8')).room.includes(remote.id));
  });

  test('本機沒有任何快取而且查不到時沿用舊規則：webhook 訊息不歸為 bot', async () => {
    env = await setup();
    const stranger = env.mock.addWebhook({ name: 'github' });
    env.mock.addMessage({ author: 'webhook', webhookId: stranger.id, username: 'claude-1', content: 'x' });
    env.mock.addMessage({ author: 'webhook', webhookId: stranger.id, username: 'ci', content: 'y' });
    env.mock.config.webhookPermission = false;
    const r = await env.run(['read', '--as', 'claude-1', '--last', '2', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().messages.map((m) => m.kind), ['self', 'agent']);
  });
});
