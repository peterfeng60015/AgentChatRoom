import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './helpers.js';
import { channelPermissions } from '../../src/commands/clear.js';

const DAY = 24 * 60 * 60 * 1000;
const FAKE_TTY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-tty.cjs');
// 讓子行程的 stdin 被當成終端機，測輸入頻道名稱的確認流程。
const TTY_ENV = { NODE_OPTIONS: `--require "${FAKE_TTY}"` };

function addRecent(mock, n) {
  for (let i = 0; i < n; i++) mock.addMessage({ author: 'human', content: `m${i}` });
}

const deleteRequests = (mock) => mock.requests.filter((r) => r.method === 'DELETE' || r.path.endsWith('/bulk-delete'));

describe('clear', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('--yes：14 天內每批 100 則、剩 1 則與更舊的逐則刪；清掉本機狀態與 wait 鎖，webhook 快取保留', async () => {
    await env.join('claude-1');
    await env.join('gemini-1');
    const agentsDir = path.dirname(env.agentFile('claude-1'));
    fs.writeFileSync(path.join(agentsDir, 'claude-1.wait.lock'), '99999');
    const webhookCache = path.join(env.stateDir, 'webhooks', `${env.mock.config.channelId}.json`);
    assert.ok(fs.existsSync(webhookCache));
    // 頻道裡已有兩則 [JOIN]，再加 99 則 → 14 天內共 101 則：一批 100、剩 1 則逐則。
    addRecent(env.mock, 99);
    const old1 = env.mock.addMessageAt(Date.now() - 20 * DAY, { content: 'old-1' });
    const old2 = env.mock.addMessageAt(Date.now() - 400 * DAY, { author: 'moderator', content: 'old-2' });

    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(env.mock.messages.length, 0);
    assert.deepEqual(env.mock.bulkDeletes.map((b) => b.length), [100]);
    assert.equal(env.mock.deletes.length, 3);
    assert.ok(env.mock.deletes.includes(old1.id) && env.mock.deletes.includes(old2.id));
    assert.match(r.stdout, /^已清空 #agent-room：刪除 103 則（其中逐則刪除 3 則），略過 0 則（已不存在），失敗 0 則/);
    assert.match(r.stdout, /已清除本機 2 個 agent 的狀態檔與 wait 鎖（claude-1、gemini-1）/);
    assert.match(r.stdout, /webhook 快取保留/);
    assert.ok(!fs.existsSync(agentsDir), 'agents/<頻道ID>/ 整個清掉（含 wait 鎖）');
    assert.ok(fs.existsSync(webhookCache), 'webhook 快取保留');

    // 清完可以用同一個名稱重新進房（不是「本機使用中」）。
    const again = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(again.code, 0, again.stderr);
  });

  test('14 天邊界：快滿 14 天（1 小時餘裕內）的改逐則刪，13 天的照批次', async () => {
    const edge = env.mock.addMessageAt(Date.now() - 14 * DAY + 30 * 60 * 1000, { content: 'edge' });
    const d13a = env.mock.addMessageAt(Date.now() - 13 * DAY, { content: 'd13a' });
    const d13b = env.mock.addMessageAt(Date.now() - 13 * DAY + 1000, { content: 'd13b' });
    const r = await env.run(['clear', '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    const j = r.json();
    assert.equal(j.ok, true);
    assert.deepEqual(env.mock.deletes, [edge.id]);
    assert.deepEqual([...env.mock.bulkDeletes[0]].sort(), [d13a.id, d13b.id].sort());
    assert.equal(j.total, 3);
    assert.equal(j.deleted, 3);
    assert.equal(j.bulkDeleted, 2);
    assert.equal(j.singleDeleted, 1);
    assert.deepEqual(j.channel, { id: env.mock.config.channelId, name: 'agent-room' });
    assert.deepEqual(j.clearedAgents, []);
  });

  test('超過 100 則分多批；只有 1 則時逐則刪', async () => {
    addRecent(env.mock, 250);
    let r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(env.mock.bulkDeletes.map((b) => b.length), [100, 100, 50]);
    assert.equal(env.mock.deletes.length, 0);

    addRecent(env.mock, 1);
    r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.deletes.length, 1);
    assert.equal(env.mock.requests.filter((q) => q.path.endsWith('/bulk-delete')).length, 3, '1 則不送 bulk-delete');
  });

  test('空頻道：刪除 0 則，照樣清本機狀態', async () => {
    await env.join('claude-1');
    env.mock.messages.length = 0;
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /刪除 0 則/);
    assert.equal(deleteRequests(env.mock).length, 0);
    assert.ok(!fs.existsSync(env.agentFile('claude-1')));
  });

  test('429：依 retry_after 等待後重試成功', async () => {
    addRecent(env.mock, 3);
    env.mock.addMessageAt(Date.now() - 30 * DAY, { content: 'old' });
    env.mock.rateLimit({ method: 'POST', path: /\/bulk-delete$/, times: 2 });
    env.mock.rateLimit({ method: 'DELETE', path: /\/messages\/\d+$/, times: 1 });
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.messages.length, 0);
    assert.equal(env.mock.requests.filter((q) => q.path.endsWith('/bulk-delete')).length, 3);
    assert.equal(env.mock.requests.filter((q) => q.method === 'DELETE').length, 2);
  });

  test('bulk-delete 回 400 時整批改逐則刪；逐則 404 算略過、400 算失敗（結束碼 1，本機狀態照清）', async () => {
    await env.join('claude-1');
    addRecent(env.mock, 3);
    const ids = env.mock.messages.map((m) => m.id);
    env.mock.fail({ method: 'POST', path: /\/bulk-delete$/, status: 400, body: { message: 'Unknown Message', code: 10008 } });
    env.mock.fail({ method: 'DELETE', path: `/channels/${env.mock.config.channelId}/messages/${ids[1]}`, status: 404, body: { message: 'Unknown Message', code: 10008 } });
    env.mock.fail({ method: 'DELETE', path: `/channels/${env.mock.config.channelId}/messages/${ids[2]}`, status: 400, body: { message: 'Cannot execute action on a system message', code: 50021 } });
    const r = await env.run(['clear', '--yes', '--json']);
    assert.equal(r.code, 1, r.stdout);
    const j = r.json();
    assert.equal(j.ok, false);
    assert.equal(j.error.code, 1);
    assert.match(j.error.message, /有 1 則訊息刪除失敗/);
    assert.equal(j.total, 4);
    assert.equal(j.bulkDeleted, 0);
    assert.equal(j.singleDeleted, 2);
    assert.equal(j.skipped, 1);
    assert.equal(j.failed, 1);
    assert.deepEqual(j.failedIds, [ids[2]]);
    assert.ok(!fs.existsSync(env.agentFile('claude-1')));

    const t = await env.run(['clear', '--yes']);
    assert.equal(t.code, 0, t.stderr);
  });

  test('沒有「管理訊息」權限：先檢查就拒絕，不刪任何訊息、不清本機狀態，說明怎麼修', async () => {
    await env.close();
    env = await setup({ mock: { manageMessages: false } });
    await env.join('claude-1');
    addRecent(env.mock, 3);
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^agentchat: bot 在 #agent-room 沒有「管理訊息」權限，無法清空頻道/);
    assert.match(r.stderr, /伺服器設定 → 角色/);
    assert.match(r.stderr, /頻道設定 → 權限/);
    assert.match(r.stderr, /Manage Messages 重新邀請 bot/);
    assert.equal(deleteRequests(env.mock).length, 0);
    assert.ok(fs.existsSync(env.agentFile('claude-1')));
  });

  test('頻道覆寫拒絕 bot 的「管理訊息」時也算沒有權限；覆寫允許時算有', async () => {
    const botId = env.mock.config.botId;
    env.mock.config.permissionOverwrites = [{ id: botId, type: 1, allow: '0', deny: String(1 << 13) }];
    addRecent(env.mock, 2);
    let r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /沒有「管理訊息」權限/);
    assert.equal(deleteRequests(env.mock).length, 0);

    env.mock.config.permissionOverwrites = [{ id: env.mock.config.guildId, type: 0, allow: '0', deny: String(1 << 16) }];
    r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /沒有「讀取訊息歷史」權限/);
    assert.equal(deleteRequests(env.mock).length, 0);

    // 角色沒有「管理訊息」、但頻道覆寫允許 bot：預檢通過（mock 只依 manageMessages 擋刪除，這裡改回 true 模擬覆寫生效）。
    env.mock.config.manageMessages = false;
    env.mock.config.permissionOverwrites = [{ id: botId, type: 1, allow: String(1 << 13), deny: '0' }];
    const doctor = await env.run(['doctor']);
    assert.match(doctor.stdout, /^\[OK\] 管理訊息：/m);
    env.mock.config.manageMessages = true;
    r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.messages.length, 0);
  });

  test('刪到一半 Discord 回 403：中止，說明已刪幾則與修正方法，本機狀態不清', async () => {
    await env.join('claude-1');
    env.mock.addMessageAt(Date.now() - 30 * DAY, { content: 'a' });
    env.mock.addMessageAt(Date.now() - 29 * DAY, { content: 'b' });
    env.mock.fail({ method: 'DELETE', status: 403, body: { message: 'Missing Permissions', code: 50013 }, skip: 1 });
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /沒有「管理訊息」權限/);
    assert.match(r.stderr, /Discord 回應：Missing Permissions；中止前已刪除 1 則，本機狀態沒有清除/);
    assert.ok(fs.existsSync(env.agentFile('claude-1')));
  });

  test('確認：非終端機又沒帶 --yes 就中止（結束碼 2），不刪任何訊息', async () => {
    await env.join('claude-1');
    const r = await env.run(['clear'], { input: 'agent-room\n' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /要在終端機輸入頻道名稱確認；非互動環境請加 --yes/);
    assert.equal(deleteRequests(env.mock).length, 0);
    assert.ok(fs.existsSync(env.agentFile('claude-1')));
    const j = await env.run(['clear', '--json']);
    assert.equal(j.code, 2);
    assert.equal(j.json().error.code, 2);
  });

  test('確認：終端機輸入正確的頻道名稱（可帶 #）才刪', async () => {
    await env.join('claude-1');
    let r = await env.run(['clear'], { input: 'agent-room\n', env: TTY_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /即將永久刪除 #agent-room（頻道 200000000000000002）目前的 1 則訊息/);
    assert.match(r.stderr, /確認請輸入頻道名稱 agent-room：/);
    assert.equal(env.mock.messages.length, 0);
    assert.ok(!fs.existsSync(env.agentFile('claude-1')));

    addRecent(env.mock, 2);
    r = await env.run(['clear'], { input: '  #agent-room  \n', env: TTY_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.messages.length, 0);
  });

  test('確認：輸入不符或直接結束輸入就中止（結束碼 2），不刪、不清狀態', async () => {
    await env.join('claude-1');
    for (const input of ['agent-roo\n', 'AGENT-ROOM\n', '\n', '']) {
      const r = await env.run(['clear'], { input, env: TTY_ENV });
      assert.equal(r.code, 2, `輸入 ${JSON.stringify(input)}`);
      assert.match(r.stderr, /輸入的頻道名稱不符，已中止，沒有刪除任何訊息/);
    }
    assert.equal(deleteRequests(env.mock).length, 0);
    assert.equal(env.mock.messages.length, 1);
    assert.ok(fs.existsSync(env.agentFile('claude-1')));
  });

  test('討論串頻道不清（結束碼 2）', async () => {
    env.mock.config.channelType = 11;
    addRecent(env.mock, 2);
    const r = await env.run(['clear', '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /是討論串，尚未支援討論串，不清空/);
    assert.equal(deleteRequests(env.mock).length, 0);
  });

  test('不接受 --as 與多餘參數；--room 照常可用；頻道不屬於 guildId 時不清', async () => {
    let r = await env.run(['clear', '--yes', '--as', 'claude-1']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /不接受 --as（agent 不可以執行 clear）/);
    r = await env.run(['clear', '--yes', 'now']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /多餘的參數：now/);

    fs.mkdirSync(path.join(env.home, 'config', 'rooms'), { recursive: true });
    fs.writeFileSync(path.join(env.home, 'config', 'rooms', 'design.json'), JSON.stringify({ ...env.room, guildId: '100000000000000009' }));
    addRecent(env.mock, 2);
    r = await env.run(['clear', '--yes', '--room', 'design']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /不屬於 room\.guildId 100000000000000009/);
    assert.equal(deleteRequests(env.mock).length, 0);

    fs.writeFileSync(path.join(env.home, 'config', 'rooms', 'design.json'), JSON.stringify(env.room));
    r = await env.run(['clear', '--yes', '--room', 'design']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.messages.length, 0);
  });

  test('help 列出 clear', async () => {
    const r = await env.run(['help']);
    assert.match(r.stdout, /^  clear /m);
    const one = await env.run(['help', 'clear']);
    assert.match(one.stdout, /^用法：agentchat clear \[--yes\]/);
  });
});

describe('doctor 的「管理訊息」檢查', () => {
  let env;
  afterEach(async () => {
    await env.close();
  });

  test('有權限 OK；沒有時 WARN 並說明只有 clear 需要（結束碼仍是 0）', async () => {
    env = await setup();
    let r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^\[OK\] 管理訊息：有「管理訊息」權限（clear 可用）$/m);

    env.mock.config.manageMessages = false;
    r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^\[WARN\] 管理訊息：bot 在這個頻道沒有「管理訊息」權限；只有 clear 需要，要用 clear 時到 Discord 的伺服器設定 → 角色/m);
    assert.match(r.stdout.trim().split('\n').at(-1), /^總結：OK \d+、WARN 2、FAIL 0/);
  });

  test('查權限失敗時 WARN 不 FAIL；頻道檢查沒過時不查', async () => {
    env = await setup();
    env.mock.fail({ method: 'GET', path: /^\/guilds\/\d+\/roles$/, status: 403, times: 10 });
    let r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^\[WARN\] 管理訊息：無法確認 bot 有沒有「管理訊息」權限（只有 clear 需要）/m);

    env.mock.config.channelGuildId = '100000000000000009';
    r = await env.run(['doctor']);
    assert.ok(!/管理訊息/.test(r.stdout));
  });
});

describe('channelPermissions', () => {
  const G = '1';
  const roles = [
    { id: G, permissions: String(1 << 10) },
    { id: '2', permissions: String(1 << 13) },
    { id: '3', permissions: String(1 << 3) },
  ];
  const has = (p, bit) => (p & BigInt(bit)) !== 0n;

  test('角色聯集、管理員全開、覆寫順序（@everyone → 角色 → 成員）', () => {
    assert.ok(has(channelPermissions({ guildId: G, userId: '9', memberRoles: ['2'], roles }), 1 << 13));
    assert.ok(!has(channelPermissions({ guildId: G, userId: '9', memberRoles: [], roles }), 1 << 13));
    const admin = channelPermissions({
      guildId: G,
      userId: '9',
      memberRoles: ['3'],
      roles,
      overwrites: [{ id: '9', type: 1, allow: '0', deny: String(1 << 13) }],
    });
    assert.ok(has(admin, 1 << 13), '管理員不受覆寫影響');
    // 角色覆寫拒絕、成員覆寫再允許 → 有。
    const p = channelPermissions({
      guildId: G,
      userId: '9',
      memberRoles: ['2'],
      roles,
      overwrites: [
        { id: '2', type: 0, allow: '0', deny: String(1 << 13) },
        { id: '9', type: 1, allow: String(1 << 13), deny: '0' },
      ],
    });
    assert.ok(has(p, 1 << 13));
    // @everyone 覆寫允許、角色覆寫拒絕 → 沒有（角色覆寫在後）。
    const q = channelPermissions({
      guildId: G,
      userId: '9',
      memberRoles: ['2'],
      roles,
      overwrites: [
        { id: G, type: 0, allow: String(1 << 13), deny: '0' },
        { id: '2', type: 0, allow: '0', deny: String(1 << 13) },
      ],
    });
    assert.ok(!has(q, 1 << 13));
    // 兩個角色覆寫一個允許、一個拒絕 → 允許優先。
    const both = channelPermissions({
      guildId: G,
      userId: '9',
      memberRoles: ['2', '4'],
      roles,
      overwrites: [
        { id: '2', type: 0, allow: '0', deny: String(1 << 13) },
        { id: '4', type: 0, allow: String(1 << 13), deny: '0' },
      ],
    });
    assert.ok(has(both, 1 << 13));
  });
});
