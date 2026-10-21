import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BIN, REPO, setup } from './helpers.js';

describe('help、sop、CLI 共通', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('help 列出所有指令；help <指令> 與 -h 印用法', async () => {
    const r = await env.run(['help']);
    assert.equal(r.code, 0);
    for (const name of ['help', 'sop', 'doctor', 'join', 'status', 'read', 'wait', 'post', 'discuss', 'ack', 'ask', 'progress', 'done', 'leave', 'download']) {
      assert.match(r.stdout, new RegExp(`^  ${name} `, 'm'), `缺少 ${name}`);
    }
    const one = await env.run(['help', 'wait']);
    assert.match(one.stdout, /^用法：agentchat wait --as <名稱> \[--timeout <秒>\] \[--until any\|mention\|moderator\]/);
    const h = await env.run(['post', '-h']);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /^用法：agentchat post/);
    const none = await env.run([]);
    assert.equal(none.code, 0);
    assert.match(none.stdout, /用法：agentchat <指令>/);
  });

  test('不認得的指令或選項 → 結束碼 2，stderr 格式 agentchat: <訊息>', async () => {
    let r = await env.run(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^agentchat: 不認得的指令：nope/);
    assert.equal(r.stdout, '');
    r = await env.run(['help', 'nope']);
    assert.equal(r.code, 2);
    r = await env.run(['status', '--as', 'claude-1', '--bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /不認得的選項 --bogus/);
  });

  test('--json：成功 { ok: true, ... }，失敗 { ok: false, error: { code, message } }，stdout 只有一個 JSON', async () => {
    let r = await env.run(['help', '--json']);
    assert.equal(r.code, 0);
    const ok = r.json();
    assert.equal(ok.ok, true);
    assert.ok(Array.isArray(ok.commands));

    r = await env.run(['status', '--as', 'claude-1', '--json']);
    assert.equal(r.code, 2);
    assert.deepEqual(Object.keys(r.json()), ['ok', 'error']);
    assert.equal(r.json().ok, false);
    assert.equal(r.json().error.code, 2);
    assert.match(r.json().error.message, /還沒進房/);
    assert.equal(r.stderr, '');

    r = await env.run(['post', '--json', '--bogus']);
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, 2);

    await env.join('claude-1');
    r = await env.run(['discuss', '--as', 'claude-1', '--json', 'x']);
    assert.equal(r.code, 3);
    assert.equal(r.json().error.code, 3);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  });

  test('sop：預設印 agent.md；moderator；--path 只印絕對路徑；檔案不存在 → 2', async () => {
    let r = await env.run(['sop']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /# agent SOP/);
    r = await env.run(['sop', 'moderator']);
    assert.match(r.stdout, /# moderator SOP/);
    r = await env.run(['sop', '--path']);
    assert.equal(r.stdout.trim(), path.join(env.home, 'SOP', 'agent.md'));
    assert.equal((await env.run(['sop', 'other'])).code, 2);
    fs.writeFileSync(path.join(env.home, 'SOP', 'setup-gemini-cli.md'), '# gemini\n');
    r = await env.run(['sop', 'setup-gemini-cli']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /# gemini/);
    assert.equal((await env.run(['sop', 'setup-codex-cli'])).code, 2, '檔案不存在');
    assert.equal((await env.run(['sop', '../agent'])).code, 2);
    fs.rmSync(path.join(env.home, 'SOP'), { recursive: true });
    r = await env.run(['sop']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /找不到 SOP 檔/);
  });

  test('設定錯誤：room.json 缺必填欄位或 ID 寫成數字 → 2；--room 讀 config/rooms/<名稱>.json', async () => {
    const file = path.join(env.home, 'config', 'room.json');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), moderatorUserId: undefined }));
    let r = await env.run(['read']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /缺少 moderatorUserId/);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), channelId: 123 }));
    assert.equal((await env.run(['read'])).code, 2);
    fs.writeFileSync(file, '{ 壞掉');
    assert.equal((await env.run(['read'])).code, 2);

    fs.mkdirSync(path.join(env.home, 'config', 'rooms'));
    fs.writeFileSync(path.join(env.home, 'config', 'rooms', 'alt.json'), good);
    r = await env.run(['read', '--room', 'alt']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await env.run(['read', '--room', '../x'])).code, 2);
    assert.equal((await env.run(['read', '--room', 'missing'])).code, 2);
  });

  test('bin 可執行，經由 symlink 執行時也找得到工具目錄', async () => {
    assert.ok(fs.statSync(BIN).mode & 0o111, 'bin/agentchat.js 要有執行權限');
    assert.match(fs.readFileSync(BIN, 'utf8'), /^#!\/usr\/bin\/env node\n/);
    const link = path.join(env.root, 'bin-link', 'agentchat');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(BIN, link);
    const r = await env.run(['sop', '--path'], { env: { AGENTCHAT_HOME: undefined } });
    const viaLink = await new Promise((resolve) => {
      import('node:child_process').then(({ execFile }) => {
        execFile(link, ['sop', '--path'], { env: { PATH: process.env.PATH, HOME: env.root } }, (err, stdout, stderr) =>
          resolve({ code: err ? err.code : 0, stdout, stderr }),
        );
      });
    });
    const expected = path.join(fs.realpathSync(REPO), 'SOP', 'agent.md');
    assert.ok((viaLink.stdout + viaLink.stderr).includes(expected), `${viaLink.stdout}${viaLink.stderr}`);
    assert.ok((r.stdout + r.stderr).includes(expected));
  });
});

describe('doctor', () => {
  let env;
  afterEach(async () => {
    await env.close();
  });

  test('全部 OK：建立 webhook，--send-test 才發測試訊息，--as 印狀態摘要', async () => {
    env = await setup();
    let r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.match(lines[0], /^\[OK\] Node：/);
    assert.ok(lines.some((l) => /^\[OK\] 房間設定：test-room（頻道 200000000000000002/.test(l)));
    assert.ok(lines.some((l) => /^\[OK\] bot 身分：agentchat-bot/.test(l)));
    assert.ok(lines.some((l) => /^\[OK\] Message Content Intent/.test(l)));
    assert.ok(lines.some((l) => /^\[OK\] 主導者：Peter（peter，id=300000000000000003）/.test(l)));
    assert.ok(lines.some((l) => /^\[OK\] webhook：已建立新的 webhook/.test(l)));
    assert.match(lines.at(-1), /^總結：OK \d+、WARN 0、FAIL 0/);
    assert.equal(env.mock.executions.length, 0, '沒帶 --send-test 不發訊息');
    assert.ok(!r.stdout.includes(env.mock.config.token));
    assert.ok(!r.stdout.includes(env.mock.webhooks[0].token));

    await env.join('claude-1');
    r = await env.run(['doctor', '--send-test', '--as', 'claude-1']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /\[OK\] webhook：本機快取有效/);
    assert.match(r.stdout, /\[OK\] 測試訊息：已送出/);
    assert.match(r.stdout, /\[OK\] agent 狀態：claude-1：階段：lobby　角色：未指派　討論：0\/3/);
    assert.equal(env.mock.lastMessage().content, '[INFO] doctor 測試');

    r = await env.run(['doctor', '--as', 'claude-2']);
    assert.match(r.stdout, /\[WARN\] agent 狀態：claude-2 還沒在這個房間 join/);
  });

  test('沒開 Message Content Intent → FAIL，結束碼 1；LIMITED 旗標也算開', async () => {
    env = await setup({ mock: { appFlags: 0 } });
    let r = await env.run(['doctor', '--json']);
    assert.equal(r.code, 1);
    const out = r.json();
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 1);
    const intent = out.checks.find((c) => c.item === 'Message Content Intent');
    assert.equal(intent.level, 'FAIL');
    assert.match(intent.message, /Developer Portal/);
    env.mock.config.appFlags = 1 << 19;
    r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stdout);
  });

  test('找不到 token → FAIL，結束碼 2（設定問題）；token 無效 → FAIL，結束碼 1，略過後續項目', async () => {
    env = await setup();
    let r = await env.run(['doctor'], { env: { DISCORD_BOT_TOKEN: undefined } });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /\[FAIL\] bot token/);
    assert.match(r.stderr, /^agentchat: doctor 有 1 項 FAIL/);

    fs.writeFileSync(path.join(env.home, '.env'), `DISCORD_BOT_TOKEN="${env.mock.config.token}"\n`);
    r = await env.run(['doctor'], { env: { DISCORD_BOT_TOKEN: undefined } });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /\[OK\] bot token：已找到（來源：.*\.env）/);

    r = await env.run(['doctor'], { env: { DISCORD_BOT_TOKEN: 'wrong-token' } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\[FAIL\] bot 身分：bot token 無效/);
    assert.ok(!/webhook/.test(r.stdout));
    assert.ok(!r.stdout.includes('wrong-token'));
  });

  test('頻道是討論串 → FAIL，結束碼 2；頻道不屬於 guildId → FAIL，結束碼 2；沒有管理 webhook 權限 → FAIL', async () => {
    env = await setup({ mock: { channelType: 11 } });
    let r = await env.run(['doctor']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /\[FAIL\] 頻道：.*尚未支援討論串/);

    env.mock.config.channelType = 0;
    env.mock.config.channelGuildId = '999';
    r = await env.run(['doctor']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /\[FAIL\] 頻道：頻道 200000000000000002 不屬於 room.guildId/);

    env.mock.config.channelGuildId = null;
    env.mock.config.webhookPermission = false;
    // 快取有效時不需要管理權限；刪掉快取才會走到清單與建立。
    fs.rmSync(path.join(env.stateDir, 'webhooks'), { recursive: true, force: true });
    r = await env.run(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\[FAIL\] webhook：.*管理 Webhook/);
  });

  test('主導者 ID 查不到 → FAIL，結束碼 2（設定問題）', async () => {
    env = await setup({ room: { moderatorUserId: '999999999999999999' } });
    const r = await env.run(['doctor']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /\[FAIL\] 主導者：找不到使用者 999999999999999999/);
  });

  test('沒有讀取訊息歷史的權限 → FAIL', async () => {
    env = await setup();
    env.mock.fail({ method: 'GET', path: /\/messages$/, status: 403, body: { message: 'Missing Access', code: 50001 } });
    const r = await env.run(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\[FAIL\] 讀取訊息：bot 沒有權限/);
  });

  test('快取的 webhook 已被刪：doctor 改用頻道裡同名的 webhook', async () => {
    env = await setup();
    await env.run(['doctor']);
    env.mock.webhooks.splice(0, 1);
    const other = env.mock.addWebhook({ name: 'agentchat' });
    const r = await env.run(['doctor']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /\[OK\] webhook：找到頻道裡既有的 webhook/);
    const cache = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'webhooks', `${env.room.channelId}.json`), 'utf8'));
    assert.equal(cache.id, other.id);
  });
});

describe('status、read、download、Discord 錯誤', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('status：印出階段、角色、議題、輪數、游標、待答問題與未讀', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', {
      assignMessageId: '8',
      assignBody: '細節第一行\n細節第二行',
      phase: 'discussion',
      role: '前端',
      task: '登入頁',
      branch: 'feat/a',
      isolation: 'worktree',
      discussRound: 1,
      pendingQuestionId: '42',
      topic: { id: '7', title: '登入', fields: { repo: '/tmp/app' }, body: '' },
    });
    env.mock.addMessage({ content: '新訊息' });
    const r = await env.run(['status', '--as', 'claude-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /階段：discussion　角色：前端　討論：1\/3/);
    assert.match(r.stdout, /分工：登入頁/);
    assert.match(r.stdout, /分工細節（\[ASSIGN\] id=8）：\n細節第一行\n細節第二行/);
    assert.match(r.stdout, /議題：「登入」（id=7）\n議題欄位：repo：\/tmp\/app　base：main　rounds：3（房間預設）/);
    assert.match(r.stdout, /待答問題：id=42/);
    assert.match(r.stdout, /未讀：1 則/);
    const out = (await env.run(['status', '--as', 'claude-1', '--json'])).json();
    assert.equal(out.ok, true);
    assert.equal(out.unread, 1);
    assert.deepEqual(out.round, { done: 1, limit: 3 });
    assert.equal(env.readState('claude-1').cursor, out.cursor, 'status 不移動游標');
  });

  test('read：預設 20 則、舊的在前、最多 100；不移動游標也不套用指令；沒有 --as 不判斷「你」', async () => {
    await env.join('claude-1');
    const cursor = env.readState('claude-1').cursor;
    for (let i = 0; i < 25; i++) env.mock.addMessage({ content: `訊息 ${i}` });
    env.mock.addMessage({ content: '[TOPIC] 不該被套用' });
    let out = (await env.run(['read', '--json'])).json();
    assert.equal(out.messages.length, 20);
    assert.equal(out.messages.at(-1).content, '[TOPIC] 不該被套用');
    assert.ok(out.messages.every((m) => m.mentionsMe === false));
    out = (await env.run(['read', '--last', '500', '--json'])).json();
    assert.equal(out.messages.length, 27);
    assert.equal(out.messages[0].kind, 'agent', '沒有 --as 時自己的 [JOIN] 是 agent');
    out = (await env.run(['read', '--as', 'claude-1', '--last', '100', '--json'])).json();
    assert.equal(out.messages[0].kind, 'self');
    assert.equal(env.readState('claude-1').cursor, cursor);
    assert.equal(env.readState('claude-1').phase, 'lobby');
    assert.equal((await env.run(['read', '--last', '0'])).code, 2);
    assert.equal((await env.run(['read', '--last', 'x'])).code, 2);
  });

  test('read --id：只印那一則；ID 不合法 → 2；不存在 → 1', async () => {
    await env.join('claude-1');
    const topic = env.mock.addMessage({ content: '[TOPIC] 舊議題\n\n內容' });
    for (let i = 0; i < 5; i++) env.mock.addMessage({ content: `之後 ${i}` });
    const r = await env.run(['read', '--as', 'claude-1', '--id', topic.id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^訊息 ${topic.id}：\n\\[\\d\\d/\\d\\d \\d\\d:\\d\\d:\\d\\d\\] 主導者 Peter  \\(id=${topic.id}\\)  ← 提到你\n\\[TOPIC\\] 舊議題`));
    assert.ok(!r.stdout.includes('之後 0'));
    assert.equal((await env.run(['read', '--id', 'abc'])).code, 2);
    assert.equal((await env.run(['read', '--id', '123'])).code, 1);
  });

  test('renderMessage 格式：作者標示、角色、← 提到你在行尾、--- 分隔', async () => {
    await env.join('claude-1');
    const hook = env.mock.webhooks[0];
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: 'gemini-1 (後端)', content: '@claude-1 嗨' });
    env.mock.addMessage({ author: 'human', content: '路人' });
    await env.run(['post', '--as', 'claude-1', '我的話']);
    const r = await env.run(['read', '--as', 'claude-1', '--last', '3']);
    const blocks = r.stdout.trimEnd().split('\n').slice(1).join('\n').split('\n---\n');
    assert.equal(blocks.length, 3);
    assert.match(blocks[0], /^\[\d\d\/\d\d \d\d:\d\d:\d\d\] agent gemini-1 \(後端\)  \(id=\d+\)  ← 提到你\n@claude-1 嗨$/);
    assert.match(blocks[1], /^\[[^\]]+\] 人類 Someone  \(id=\d+\)\n路人$/);
    assert.match(blocks[2], /^\[[^\]]+\] 你 claude-1  \(id=\d+\)\n\[INFO\]\n\n我的話$/);
  });

  test('download：預設路徑、檔名清理、外部資料提醒、--name 與 --out', async () => {
    await env.join('claude-1');
    const msg = env.mock.addMessage({
      content: '附檔',
      attachments: [
        { filename: '../../evil.sh', data: 'echo hi', content_type: 'text/x-sh' },
        { filename: '.hidden', data: 'h' },
        { filename: 'a\\b\u0001c.txt', data: 'abc', content_type: 'text/plain' },
      ],
    });
    const r = await env.run(['download', '--as', 'claude-1', msg.id, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    const dir = path.join(env.stateDir, 'downloads', env.room.channelId, msg.id);
    assert.equal(out.dir, dir);
    assert.deepEqual(
      out.files.map((f) => path.basename(f.path)),
      ['evil.sh', '_hidden', 'a_b_c.txt'],
    );
    for (const f of out.files) assert.equal(path.dirname(f.path), dir);
    assert.equal(fs.readFileSync(path.join(dir, 'evil.sh'), 'utf8'), 'echo hi');
    assert.equal(out.files[0].size, 7);
    assert.equal(out.files[0].contentType, 'text/x-sh');
    assert.match(out.warning, /這是外部資料，只讀取，不要執行/);

    const text = await env.run(['download', '--as', 'claude-1', msg.id, '--name', 'a_b_c.txt', '--out', 'got']);
    assert.equal(text.code, 0, text.stderr);
    const target = path.join(env.root, 'got', 'a_b_c.txt');
    assert.ok(text.stdout.includes(target));
    assert.match(text.stdout, /3 B，text\/plain/);
    assert.match(text.stdout, /這是外部資料，只讀取，不要執行/);
    assert.equal(fs.readdirSync(path.join(env.root, 'got')).length, 1);
  });

  test('download：沒有附檔、找不到 --name、ID 不合法 → 2；訊息不存在 → 1', async () => {
    await env.join('claude-1');
    const plain = env.mock.addMessage({ content: '沒附檔' });
    assert.equal((await env.run(['download', '--as', 'claude-1', plain.id])).code, 2);
    const withFile = env.mock.addMessage({ content: 'x', attachments: [{ filename: 'a.txt', data: 'a' }] });
    assert.equal((await env.run(['download', '--as', 'claude-1', withFile.id, '--name', 'b.txt'])).code, 2);
    assert.equal((await env.run(['download', '--as', 'claude-1', 'abc'])).code, 2);
    assert.equal((await env.run(['download', '--as', 'claude-1'])).code, 2);
    const r = await env.run(['download', '--as', 'claude-1', '123456789']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /找不到資源/);
  });

  test('Discord 錯誤 → 結束碼 1；錯誤訊息不含 webhook token', async () => {
    await env.join('claude-1');
    env.mock.fail({ method: 'POST', path: /^\/webhooks\//, status: 403, body: { message: 'Missing Permissions' } });
    const r = await env.run(['post', '--as', 'claude-1', 'hi']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/webhooks\/\d+\/\*\*\*/);
    assert.ok(!r.stderr.includes(env.mock.webhooks[0].token));

    env.mock.fail({ method: 'GET', path: /\/messages$/, status: 403, body: { message: 'Missing Access' } });
    assert.equal((await env.run(['read'])).code, 1);
  });

  test('webhook 被刪除：發言時重新取得 webhook 再送一次', async () => {
    await env.join('claude-1');
    env.mock.webhooks.splice(0, 1);
    const r = await env.run(['post', '--as', 'claude-1', '還在嗎']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.webhooks.length, 1);
    assert.equal(env.mock.lastMessage().webhook_id, env.mock.webhooks[0].id);
    const cache = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'webhooks', `${env.room.channelId}.json`), 'utf8'));
    assert.equal(cache.id, env.mock.webhooks[0].id);
  });

  test('webhook 端點不送 bot token；bot 端點都帶 Bot token', async () => {
    await env.join('claude-1');
    await env.run(['post', '--as', 'claude-1', 'hi']);
    const hookReqs = env.mock.requests.filter((q) => q.path.startsWith('/api/v10/webhooks/'));
    assert.ok(hookReqs.length > 0);
    assert.ok(hookReqs.every((q) => q.auth === null));
    const botReqs = env.mock.requests.filter((q) => q.path.startsWith('/api/v10/channels/'));
    assert.ok(botReqs.every((q) => q.auth === `Bot ${env.mock.config.token}`));
  });
});
