// avatar 指令的邊界情況（SPEC §6.3 avatar 第 1～4 步、§9 秘密檢查）。基本流程在 self-avatar.test.js。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(env, name = 'a.png', fill = 'x') {
  const file = path.join(env.root, name);
  fs.writeFileSync(file, Buffer.concat([PNG_HEAD, Buffer.from(fill.repeat(20))]));
  return file;
}
const hookFile = (env, name) => path.join(env.stateDir, 'webhooks', env.room.channelId, `${name}.json`);
const readCache = (env, name) => JSON.parse(fs.readFileSync(hookFile(env, name), 'utf8'));
const tokensOf = (env) => env.mock.webhooks.map((w) => w.token);
const assertNoToken = (env, r) => {
  for (const t of tokensOf(env)) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t), '輸出不能有 webhook token');
};
const patches = (env) => env.mock.requests.filter((q) => q.method === 'PATCH');

describe('avatar：取得專屬 webhook 的順序', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('快取的 token 失效（PATCH 401）時刪掉快取，改沿用頻道裡同名的', async () => {
    env = await setup();
    await env.join('claude-1');
    const hook = env.mock.addWebhook({ name: 'agentchat-claude-1' });
    fs.mkdirSync(path.dirname(hookFile(env, 'claude-1')), { recursive: true });
    const stale = { id: hook.id, token: 'stale-token-0123456789', channelId: env.room.channelId, name: hook.name, agent: 'claude-1' };
    fs.writeFileSync(hookFile(env, 'claude-1'), JSON.stringify(stale));

    const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env), '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json().source, 'found');
    assert.equal(readCache(env, 'claude-1').token, hook.token, '快取換成清單裡的 token');
    assert.equal(patches(env).length, 2, '先 PATCH 快取（401），再 PATCH 清單裡的');
    assert.ok(!r.stdout.includes('stale-token-0123456789'));
    assertNoToken(env, r);
  });

  test('頻道裡有多個同名 webhook：挑 ID 最小而且有 token 的', async () => {
    env = await setup();
    await env.join('claude-1');
    const noToken = env.mock.addWebhook({ name: 'agentchat-claude-1' });
    delete noToken.token; // ID 最小但沒有 token（例如別的應用程式建立的）
    const first = env.mock.addWebhook({ name: 'agentchat-claude-1' });
    env.mock.addWebhook({ name: 'agentchat-claude-1' });
    env.mock.addWebhook({ name: 'agentchat-claude-10' });
    // 清單順序和 ID 順序不同，確認是比 ID 而不是取第一個。
    env.mock.webhooks.reverse();

    const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.source, 'found');
    assert.equal(out.webhook.id, first.id);
    assert.equal(readCache(env, 'claude-1').id, first.id);
    assert.ok(first.avatar?.startsWith('data:image/png;base64,'));
  });

  test('清單裡同名的在 PATCH 前被刪掉（404）時改建新的', async () => {
    env = await setup();
    await env.join('claude-1');
    const gone = env.mock.addWebhook({ name: 'agentchat-claude-1' });
    env.mock.fail({ method: 'PATCH', path: new RegExp(`^/webhooks/${gone.id}/`), status: 404, body: { message: 'Unknown Webhook', code: 10015 } });
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env), '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json().source, 'created');
    assert.notEqual(r.json().webhook.id, gone.id);
  });

  test('--json 欄位：ok、name、webhook { id, name }、source、bytes、format，沒有 token', async () => {
    env = await setup();
    await env.join('Claude-1');
    const file = png(env);
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', file, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.deepEqual(Object.keys(out).sort(), ['bytes', 'format', 'name', 'ok', 'source', 'webhook']);
    assert.deepEqual(Object.keys(out.webhook).sort(), ['id', 'name']);
    assert.equal(out.ok, true);
    assert.equal(out.name, 'Claude-1');
    assert.equal(out.webhook.name, 'agentchat-claude-1');
    assert.equal(out.bytes, fs.statSync(file).size);
    assert.equal(out.format, 'png');
    assertNoToken(env, r);

    const t = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(t.code, 0);
    assert.match(t.stdout, new RegExp(`已設定 Claude-1 的頭像（更新專屬 webhook，agentchat-claude-1，id=${out.webhook.id}）`));
    assert.match(t.stdout, /之後的發言會顯示這張頭像/);
    assertNoToken(env, t);
  });

  test('不發訊息、不改 agent 狀態', async () => {
    env = await setup();
    await env.join('claude-1');
    const before = fs.readFileSync(env.agentFile('claude-1'), 'utf8');
    const count = env.mock.messages.length;
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    assert.equal(env.mock.messages.length, count);
    assert.equal(fs.readFileSync(env.agentFile('claude-1'), 'utf8'), before);
  });
});

describe('avatar：Discord 拒絕時的說明與結束碼', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  const POST_HOOK = /^\/channels\/\d+\/webhooks$/;

  for (const code of [50138, 40005, 50045]) {
    test(`錯誤碼 ${code}：說明 Discord 拒收這張圖，結束碼 1`, async () => {
      env = await setup();
      await env.join('claude-1');
      env.mock.fail({ method: 'POST', path: POST_HOOK, status: 400, body: { message: 'rejected', code } });
      const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env), '--json']);
      assert.equal(r.code, 1);
      assert.equal(r.json().error.code, 1);
      assert.match(r.json().error.message, /Discord 拒收這張頭像/);
    });
  }

  test('413：說明拒收，結束碼 2（§6.2）', async () => {
    env = await setup();
    await env.join('claude-1');
    env.mock.fail({ method: 'POST', path: POST_HOOK, status: 413, body: { message: 'Request entity too large', code: 40005 } });
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env)]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Discord 拒收這張頭像/);
  });

  test('50035 指出 avatar 時算圖被拒；指出別的欄位時保留 Discord 的原因', async () => {
    env = await setup();
    await env.join('claude-1');
    env.mock.fail({
      method: 'POST',
      path: POST_HOOK,
      status: 400,
      body: { message: 'Invalid Form Body', code: 50035, errors: { avatar: { _errors: [{ code: 'IMAGE_INVALID', message: 'Invalid image data' }] } } },
    });
    let r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Discord 拒收這張頭像/);

    env.mock.fail({
      method: 'POST',
      path: POST_HOOK,
      status: 400,
      body: { message: 'Invalid Form Body', code: 50035, errors: { name: { _errors: [{ code: 'BASE_TYPE_BAD', message: 'bad name' }] } } },
    });
    r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env)]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, /拒收這張頭像/);
    assert.match(r.stderr, /name：bad name/);
  });

  test('30007（webhook 上限）說明上限與 clear，結束碼 1', async () => {
    env = await setup();
    await env.join('claude-1');
    env.mock.fail({ method: 'POST', path: POST_HOOK, status: 400, body: { message: 'Maximum number of webhooks reached (15)', code: 30007 } });
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', png(env), '--json']);
    assert.equal(r.code, 1);
    assert.match(r.json().error.message, /上限 15 個/);
    assert.match(r.json().error.message, /agentchat clear/);
  });

  test('403：說明缺「管理 Webhook」，結束碼 1；有快取時不需要這個權限', async () => {
    env = await setup();
    await env.join('claude-1');
    const file = png(env);
    env.mock.config.webhookPermission = false;
    let r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /管理 Webhook/);

    env.mock.config.webhookPermission = true;
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', file])).code, 0);
    env.mock.config.webhookPermission = false;
    r = await env.run(['avatar', '--as', 'claude-1', '--file', file, '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json().source, 'updated');
  });

  test('PATCH 回 401 以外的錯誤（例如 400 圖被拒）時不刪快取', async () => {
    env = await setup();
    await env.join('claude-1');
    const file = png(env);
    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', file])).code, 0);
    env.mock.fail({ method: 'PATCH', path: /^\/webhooks\//, status: 400, body: { message: 'too big', code: 50138 } });
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Discord 拒收這張頭像/);
    assert.ok(fs.existsSync(hookFile(env, 'claude-1')), '快取還在');
    assertNoToken(env, r);
  });
});

describe('avatar：§9 秘密檢查與階段', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('含專屬 webhook token 的圖檔拒絕（結束碼 2），不打 API', async () => {
    env = await setup();
    await env.join('claude-1');
    await env.join('claude-2');
    assert.equal((await env.run(['avatar', '--as', 'claude-2', '--file', png(env)])).code, 0);
    const token = readCache(env, 'claude-2').token;
    const file = path.join(env.root, 'leak.png');
    fs.writeFileSync(file, Buffer.concat([PNG_HEAD, Buffer.from(`xx${token}xx`)]));
    const before = env.mock.requests.length;
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /webhook token/);
    assert.ok(!r.stderr.includes(token));
    assert.equal(env.mock.requests.length, before);
  });

  test('含私鑰的圖檔拒絕；專屬 webhook 快取本身不能當圖檔', async () => {
    env = await setup();
    await env.join('claude-1');
    const file = path.join(env.root, 'key.png');
    fs.writeFileSync(file, Buffer.concat([PNG_HEAD, Buffer.from('-----BEGIN RSA PRIVATE KEY-----\n')]));
    let r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /私鑰/);

    assert.equal((await env.run(['avatar', '--as', 'claude-1', '--file', png(env)])).code, 0);
    r = await env.run(['avatar', '--as', 'claude-1', '--file', hookFile(env, 'claude-1')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /狀態目錄/);
  });

  test('只有 left 欄位或只有 phase 為 left 都拒絕（結束碼 3）', async () => {
    env = await setup();
    await env.join('claude-1');
    const file = png(env);
    env.patchState('claude-1', { phase: 'left' });
    let r = await env.run(['avatar', '--as', 'claude-1', '--file', file, '--json']);
    assert.equal(r.code, 3);
    assert.match(r.json().error.message, /你已離開這個房間/);
    env.patchState('claude-1', { phase: 'lobby', left: true });
    r = await env.run(['avatar', '--as', 'claude-1', '--file', file]);
    assert.equal(r.code, 3);
    assert.equal(env.mock.webhooks.filter((w) => w.name === 'agentchat-claude-1').length, 0);
  });

  test('剛好 8 MB 接受、多 1 位元組拒絕', async () => {
    env = await setup();
    await env.join('claude-1');
    const exact = path.join(env.root, 'exact.png');
    fs.writeFileSync(exact, Buffer.concat([PNG_HEAD, Buffer.alloc(8 * 1024 * 1024 - PNG_HEAD.length, 0x41)]));
    // 假伺服器不限制大小；這裡只驗工具自己的上限。
    const r = await env.run(['avatar', '--as', 'claude-1', '--file', exact, '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json().bytes, 8 * 1024 * 1024);
    const over = path.join(env.root, 'over.png');
    fs.writeFileSync(over, Buffer.concat([PNG_HEAD, Buffer.alloc(8 * 1024 * 1024 - PNG_HEAD.length + 1, 0x41)]));
    const o = await env.run(['avatar', '--as', 'claude-1', '--file', over]);
    assert.equal(o.code, 2);
    assert.match(o.stderr, /超過 8 MB/);
  });
});
