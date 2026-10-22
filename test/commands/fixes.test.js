// review 找到的問題與後續規格調整的回歸測試：每一則都對應一個修正，改壞時要變紅。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, setup, webhookMessages } from './helpers.js';
import { createClient } from '../../src/discord.js';
import { DiscordError } from '../../src/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const webhookPosts = (mock) => mock.requests.filter((q) => q.method === 'POST' && q.path.startsWith('/api/v10/webhooks/'));

describe('CLI 與指令層的修正', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('--json、-h 放在指令前面也照常執行；--json nope → 2；-- 之後仍是內文', async () => {
    await env.join('claude-1');
    let r = await env.run(['--json', 'post', '--as', 'claude-1', '前置旗標']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().tag, 'INFO');
    assert.equal(env.mock.executions.at(-1).payload.content, '[INFO]\n\n前置旗標');
    r = await env.run(['-h', 'post']);
    assert.match(r.stdout, /^用法：agentchat post/);
    r = await env.run(['--json', 'nope']);
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, 2);
    r = await env.run(['--json', 'post', '--as', 'claude-1', '--', '-5 開頭']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '[INFO]\n\n-5 開頭');
  });

  test('post：沒給 --as 或還沒 join 時，就算 --tag 是主導者標籤也先回 2', async () => {
    assert.equal((await env.run(['post', '--tag', 'topic', 'x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'nobody', '--tag', 'topic', 'x'])).code, 2);
  });

  test('left 階段的拒絕訊息不重複', async () => {
    await env.join('claude-1');
    await env.run(['leave', '--as', 'claude-1']);
    const r = await env.run(['post', '--as', 'claude-1', 'x']);
    assert.equal(r.code, 3);
    assert.equal(r.stderr.split('你已離開這個房間').length - 1, 1);
  });

  test('post 內文自帶標籤時不能再給不同的 --tag、--title、--field；- 後面不能再接內文', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'discussion' });
    assert.equal((await env.run(['post', '--as', 'claude-1', '--tag', 'DISCUSS', '[INFO] x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'claude-1', '--title', 't', '[INFO] x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'claude-1', '--field', 'branch=b', '[INFO] x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'claude-1', '--tag', 'info', '[INFO] 同標籤可以'])).code, 0);
    assert.equal((await env.run(['post', '--as', 'claude-1', '-', '另一段'], { input: 'stdin' })).code, 2);
    assert.equal(env.readState('claude-1').discussRound, 0);
  });

  test('progress、done 的內文自帶標籤列時，選項會被丟掉，所以結束碼 2', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'work' });
    assert.equal((await env.run(['progress', '--as', 'claude-1', '--percent', '50', '[PROGRESS] 一半'])).code, 2);
    assert.equal((await env.run(['done', '--as', 'claude-1', '--commit', 'abc', '[DONE] 完成'])).code, 2);
    assert.equal(env.readState('claude-1').lastProgressAt, null);
    assert.equal((await env.run(['done', '--as', 'claude-1', '[DONE] 不帶選項可以'])).code, 0);
  });

  test('--body-file：不是一般檔案、空檔、超過 maxFileMB → 2', async () => {
    await env.close();
    env = await setup({ room: { maxFileMB: 0.001 } });
    await env.join('claude-1');
    const dir = path.join(env.root, 'adir');
    fs.mkdirSync(dir);
    const empty = path.join(env.root, 'empty.md');
    fs.writeFileSync(empty, '  \n\n ');
    const big = path.join(env.root, 'big.md');
    fs.writeFileSync(big, 'x'.repeat(2000));
    for (const [file, why] of [[dir, /不是一般檔案/], [empty, /是空的/], [big, /超過/]]) {
      const r = await env.run(['post', '--as', 'claude-1', '--body-file', file]);
      assert.equal(r.code, 2, file);
      assert.match(r.stderr, why);
    }
  });

  test('doctor：channelId 找不到是設定問題（2），頻道檢查沒過時不建立 webhook', async () => {
    await env.close();
    env = await setup({ room: { channelId: '999999999999999999' } });
    let r = await env.run(['doctor']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /\[FAIL\] 頻道：找不到頻道 999999999999999999/);
    assert.match(r.stdout, /\[WARN\] webhook：頻道檢查沒通過/);
    assert.equal(env.mock.webhooks.length, 0);
    await env.close();
    env = await setup({ mock: { channelGuildId: '999' } });
    r = await env.run(['doctor']);
    assert.equal(r.code, 2);
    assert.equal(env.mock.webhooks.length, 0, 'guild 不符時不在那個頻道建 webhook');
  });

  test('doctor --send-test --as：測試訊息用 <webhookName>-doctor 發，不影響之後 join', async () => {
    const r = await env.run(['doctor', '--as', 'claude-1', '--send-test']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(env.mock.lastMessage().author.username, 'agentchat-doctor');
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude'])).code, 0);
  });

  test('bin：讀取端很慢時輸出也不會被截斷', async () => {
    for (let i = 0; i < 60; i++) env.mock.addMessage({ content: `${i} ${'長'.repeat(1900)}` });
    const fast = await env.run(['read', '--last', '60']);
    assert.equal(fast.code, 0);
    const child = spawn(process.execPath, [BIN, 'read', '--last', '60'], {
      env: {
        PATH: process.env.PATH,
        HOME: env.root,
        AGENTCHAT_HOME: env.home,
        AGENTCHAT_STATE_DIR: env.stateDir,
        AGENTCHAT_API_BASE: env.mock.apiBase,
        DISCORD_BOT_TOKEN: env.mock.config.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pause();
    await sleep(3500);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stdout.resume();
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.equal(Buffer.concat(chunks).toString('utf8'), fast.stdout);
  });

  test('download --out 不覆蓋既有檔案（改名存）；預設資料夾裡有同名資料夾 → 2', async () => {
    await env.join('claude-1');
    const out = path.join(env.root, 'work');
    fs.mkdirSync(path.join(out, 'src'), { recursive: true });
    fs.writeFileSync(path.join(out, 'package.json'), '{"name":"original"}');
    const msg = env.mock.addMessage({
      content: '附檔',
      attachments: [
        { filename: 'package.json', data: '{"scripts":{"postinstall":"evil"}}' },
        { filename: 'src', data: 'x' },
      ],
    });
    const r = await env.run(['download', '--as', 'claude-1', msg.id, '--out', out, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().files.map((f) => path.basename(f.path)), ['package (2).json', 'src (2)']);
    assert.equal(fs.readFileSync(path.join(out, 'package.json'), 'utf8'), '{"name":"original"}');

    const other = env.mock.addMessage({ content: 'x', attachments: [{ filename: 'sub', data: 'x' }] });
    fs.mkdirSync(path.join(env.stateDir, 'downloads', env.room.channelId, other.id, 'sub'), { recursive: true });
    const d = await env.run(['download', '--as', 'claude-1', other.id]);
    assert.equal(d.code, 2);
    assert.match(d.stderr, /同名的資料夾/);
  });

  test('多段發言中途失敗：說明已送出幾段、狀態照樣更新；發言遇到 5xx 不重試', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'discussion' });
    env.mock.fail({ method: 'POST', path: /^\/webhooks\//, status: 400, body: { message: 'boom' }, skip: 1 });
    const long = Array.from({ length: 40 }, (_, i) => `第 ${i} 行 ${'字'.repeat(60)}`).join('\n');
    let r = await env.run(['discuss', '--as', 'claude-1', long]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /已送出 1\/2 段/);
    const s = env.readState('claude-1');
    assert.equal(s.discussRound, 1, '第一段已送出，這則算數');
    assert.ok(s.ownMessageIds.includes(env.mock.lastMessage().id));

    const before = webhookPosts(env.mock).length;
    env.mock.fail({ method: 'POST', path: /^\/webhooks\//, status: 500 });
    r = await env.run(['post', '--as', 'claude-1', '短訊息']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /可能已經送出，先用 agentchat read --last 5 確認/);
    assert.equal(webhookPosts(env.mock).length - before, 1, '只送一次，不重試');
  });

  test('discuss 輪數在鎖內預扣：只剩一輪時同時送兩則，只有一則成功；全部失敗時退回', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'discussion', discussRound: 2 });
    env.mock.delay({ method: 'POST', path: /^\/webhooks\//, ms: 300, times: 2 });
    const results = await Promise.all([
      env.run(['discuss', '--as', 'claude-1', '甲']),
      env.run(['discuss', '--as', 'claude-1', '乙']),
    ]);
    assert.deepEqual(results.map((x) => x.code).sort(), [0, 3]);
    assert.equal(env.readState('claude-1').discussRound, 3);

    env.patchState('claude-1', { discussRound: 0 });
    env.mock.fail({ method: 'POST', path: /^\/webhooks\//, status: 400, body: { message: 'boom' } });
    assert.equal((await env.run(['discuss', '--as', 'claude-1', '失敗'])).code, 1);
    assert.equal(env.readState('claude-1').discussRound, 0);
  });

  test('同名 wait 互斥（結束碼 3）；殘留的鎖（pid 已不在）直接接手', async () => {
    await env.join('claude-1');
    const first = env.run(['wait', '--as', 'claude-1', '--timeout', '2']);
    await sleep(600);
    const second = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(second.code, 3);
    assert.match(second.stderr, /同名已有另一個 wait 在執行，先讀完它的輸出/);
    assert.equal((await first).code, 0);

    const lock = path.join(env.stateDir, 'agents', env.room.channelId, 'claude-1.wait.lock');
    fs.writeFileSync(lock, '999999');
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--timeout', '0'])).code, 0);
    assert.ok(!fs.existsSync(lock), '結束時刪掉鎖');
  });

  test('wait 單次最多 50 則（partial），游標只到第 50 則；注意與提醒在訊息前面', async () => {
    await env.join('claude-1');
    env.mock.addMessage({ content: '[TOPIC] 大量訊息' });
    const added = [];
    for (let i = 0; i < 60; i++) added.push(env.mock.addMessage({ author: 'human', content: `訊息 ${i}` }));
    let r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    let out = r.json();
    assert.equal(out.status, 'partial');
    assert.equal(out.messages.length, 50);
    assert.equal(env.readState('claude-1').cursor, added[48].id);
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(out.messages.length, 11);

    env.mock.addMessage({ content: '[CLOSE]' });
    r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.ok(r.stdout.indexOf('注意') < r.stdout.indexOf('│ '), r.stdout);
    for (let i = 0; i < 55; i++) env.mock.addMessage({ author: 'human', content: `再 ${i}` });
    r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /^狀態：還有未讀，先處理這 50 則，再執行 agentchat wait --timeout 0/);
  });

  test('join：空頻道游標是 0；讀不到歷史（權限不足）時改用頻道的 last_message_id', async () => {
    await env.join('claude-1');
    assert.equal(env.readState('claude-1').cursor, '0');
    env.mock.addMessage({ content: '進房後的訊息' });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(out.messages.length, 1);

    await env.close();
    env = await setup({ mock: { hideHistory: true } });
    const old = env.mock.addMessage({ content: '看不到的舊訊息' });
    await env.join('claude-2');
    assert.equal(env.readState('claude-2').cursor, old.id);
  });

  test('附檔總和上限可在 room.json 調；Discord 回 413 → 結束碼 2', async () => {
    await env.close();
    env = await setup({ room: { maxFileMB: 1, maxUploadMB: 1 } });
    await env.join('claude-1');
    const a = path.join(env.root, 'a.bin');
    fs.writeFileSync(a, Buffer.alloc(600 * 1024));
    let r = await env.run(['post', '--as', 'claude-1', '--file', a, '--file', a, 'x']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /總和超過 1 MB/);
    env.mock.fail({ method: 'POST', path: /^\/webhooks\//, status: 413, body: { message: 'Request entity too large' } });
    r = await env.run(['post', '--as', 'claude-1', '--file', a, 'x']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Discord 拒收/);
  });

  test('token 防外洩：內文或附檔含 bot token、webhook token 就拒絕，也不寫進 log', async () => {
    await env.close();
    env = await setup({ mock: { token: `MTIz.${'S'.repeat(60)}` } });
    await env.join('claude-1');
    const before = env.mock.executions.length;
    const hookFile = path.join(env.stateDir, 'webhooks', `${env.room.channelId}.json`);
    let r = await env.run(['post', '--as', 'claude-1', '--body-file', hookFile]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /含有 bot token 或 webhook token/);
    fs.writeFileSync(path.join(env.home, '.env'), `DISCORD_BOT_TOKEN=${env.mock.config.token}\n`);
    r = await env.run(['post', '--as', 'claude-1', '--file', path.join(env.home, '.env'), '設定檔']);
    assert.equal(r.code, 2);
    r = await env.run(['post', '--as', 'claude-1', `token 是 ${env.mock.config.token}`]);
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes(env.mock.config.token));
    assert.equal(env.mock.executions.length, before);
    const log = fs.readFileSync(path.join(env.stateDir, 'logs', `${env.room.channelId}.jsonl`), 'utf8');
    assert.ok(!log.includes(env.mock.config.token) && !log.includes(env.mock.webhooks[0].token));
  });

  test('token 含換行 → 結束碼 2，不印出 token、不送任何請求', async () => {
    const before = env.mock.requests.length;
    const bad = 'AAAA.SECRETPART\nBBBB';
    let r = await env.run(['read'], { env: { DISCORD_BOT_TOKEN: bad } });
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes('SECRETPART'));
    r = await env.run(['doctor'], { env: { DISCORD_BOT_TOKEN: bad } });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /\[FAIL\] bot token：DISCORD_BOT_TOKEN 含有/);
    assert.ok(!r.stdout.includes('SECRETPART'));
    assert.equal(env.mock.requests.length, before);
  });

  test('Discord 400 錯誤帶出真正原因；webhook 端點的 401 提示 webhook 失效', async () => {
    await env.join('claude-1');
    env.mock.fail({
      method: 'POST',
      path: /^\/webhooks\//,
      status: 400,
      body: { message: 'Invalid Form Body', errors: { username: { _errors: [{ code: 'X', message: 'Username cannot contain "discord"' }] } } },
    });
    let r = await env.run(['post', '--as', 'claude-1', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /username：Username cannot contain "discord"/);
    env.mock.fail({ method: 'POST', path: /^\/webhooks\//, status: 401, body: { message: 'Invalid Webhook Token' }, times: 2 });
    r = await env.run(['post', '--as', 'claude-1', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /webhook 已失效/);
    assert.ok(!r.stderr.includes('bot token 無效'));
  });

  test('系統訊息（釘選）不算回覆、不輸出，也不會清掉待答問題', async () => {
    await env.join('claude-1');
    await env.run(['ask', '--as', 'claude-1', '問題']);
    const q = env.mock.lastMessage();
    env.mock.addMessage({ type: 6, content: '', replyTo: q.id });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'timeout');
    assert.equal(out.messages.length, 0);
    assert.equal(env.readState('claude-1').pendingQuestionId, q.id);
  });

  test('wait 等待中另外 ask，主導者回覆那則提問會讓 wait 提早結束', async () => {
    await env.join('claude-1');
    const t0 = Date.now();
    const waiting = env.run(['wait', '--as', 'claude-1', '--until', 'mention', '--timeout', '8', '--json']);
    await sleep(300);
    await env.run(['ask', '--as', 'claude-1', '等待中問的']);
    env.mock.addMessage({ content: '回答', replyTo: env.mock.lastMessage().id });
    const out = (await waiting).json();
    assert.equal(out.status, 'matched');
    assert.ok(Date.now() - t0 < 6000);
  });

  test('done 送出期間收到 [STOP]：階段維持 stopped，不被蓋回 done', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'work', assigned: true });
    env.mock.delay({ method: 'POST', path: /^\/webhooks\//, ms: 800 });
    const done = env.run(['done', '--as', 'claude-1', '做完了']);
    await sleep(200);
    env.mock.addMessage({ content: '[STOP]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal((await done).code, 0);
    assert.equal(env.readState('claude-1').phase, 'stopped');
  });

  test('角色含 discord、clyde 會換成 dc、cl，發言照常（假 Discord 也拒收這兩個字）', async () => {
    await env.join('claude-1');
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: Discord API' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').role, 'dc-API');
    const r = await env.run(['ack', '--as', 'claude-1', '收到']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.username, 'claude-1 (dc-API)');
  });

  test('保留字不能當名稱；名稱比對不分大小寫（狀態檔名一律小寫）', async () => {
    for (const name of ['moderator', 'ALL', 'Here', 'agents', 'everyone']) {
      assert.equal((await env.run(['join', '--as', name, '--vendor', 'claude'])).code, 2, name);
    }
    await env.join('Claude-1');
    // macOS 預設不分大小寫，existsSync 看不出來，要看目錄裡實際的檔名。
    assert.ok(fs.readdirSync(path.join(env.stateDir, 'agents', env.room.channelId)).includes('claude-1.json'));
    assert.equal((await env.run(['post', '--as', 'claude-1', '小寫也是我'])).code, 0);
    assert.equal(env.mock.executions.at(-1).payload.username, 'Claude-1');
    const out = (await env.run(['wait', '--as', 'CLAUDE-1', '--timeout', '0', '--json'])).json();
    assert.equal(out.messages.length, 0, '自己的訊息不輸出');
    // 本房 webhook 發出、顯示名稱只差大小寫的訊息也是自己的（§6.1 名稱比對不分大小寫）。
    env.mock.addMessage({ author: 'webhook', webhookId: env.mock.webhooks[0].id, username: 'CLAUDE-1 (前端)', content: '大寫的我' });
    const again = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(again.messages.length, 0);
  });

  test('status：印語言、作業 repo、base 與最近一次的注意；join 的注意也存進去', async () => {
    env.mock.addMessage({ content: '[TOPIC] 登入\nrepo: /tmp/app\nbase: dev' });
    await env.join('claude-1');
    assert.ok(env.readState('claude-1').lastNotes.length > 0, 'join 的注意存進 lastNotes');
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    const r = await env.run(['status', '--as', 'claude-1']);
    assert.match(r.stdout, /語言：zh-TW/);
    assert.match(r.stdout, /作業 repo：\/tmp\/app/);
    assert.match(r.stdout, /base：dev/);
    assert.match(r.stdout, /最近一次的注意\n- 你被指派/, '沒有新注意的 wait 保留上一次的');
    const out = (await env.run(['status', '--as', 'claude-1', '--json'])).json();
    assert.equal(out.language, 'zh-TW');
    assert.equal(out.repo, '/tmp/app');
    assert.equal(out.base, 'dev');
  });

  test('未讀超過抓取上限時標成 N+', async () => {
    await env.join('claude-1');
    for (let i = 0; i < 520; i++) env.mock.addMessage({ author: 'human', content: `m${i}` });
    const r = await env.run(['post', '--as', 'claude-1', 'hi']);
    assert.match(r.stdout, /未讀：\d{3}\+ 則，先用 agentchat wait --timeout 0 讀取/);
  });
});

describe('設定檔與協定的修正', () => {
  let env;
  afterEach(async () => {
    await env?.close();
    env = null;
  });

  test('room.json：null／空字串用預設值；輪數要整數；idleLimitMin 至少 1；.env 行內註解', async () => {
    env = await setup({ room: { webhookName: '', defaultBase: null } });
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude'])).code, 0);
    assert.equal(env.mock.webhooks[0].name, 'agentchat');
    await env.close();
    env = await setup({ room: { maxDiscussionRounds: 2.5 } });
    assert.equal((await env.run(['read'])).code, 2);
    await env.close();
    env = await setup({ room: { idleLimitMin: 0 } });
    assert.equal((await env.run(['read'])).code, 2);
    await env.close();
    env = await setup();
    fs.writeFileSync(path.join(env.home, '.env'), `DISCORD_BOT_TOKEN=${env.mock.config.token} # 我的 bot\n`);
    const r = await env.run(['doctor'], { env: { DISCORD_BOT_TOKEN: undefined } });
    assert.equal(r.code, 0, r.stdout);
  });

  test('[CONTINUE]：@名稱後面緊接中文、全形數字都取得到 n', async () => {
    env = await setup();
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'discussion', assigned: true });
    env.mock.addMessage({ content: '[CONTINUE] @claude-1再討論2輪' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').discussLimit, 2);
    env.mock.addMessage({ content: '[CONTINUE] @claude-1 再３輪' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').discussLimit, 3);
  });

  test('ASSIGN 多人同 branch 提醒：重複 @ 同一人、@角色 不算多人；@ 到另一個 agent 才算', async () => {
    env = await setup();
    await env.join('claude-1');
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1 @claude-1 請和@前端協調\nbranch: b' });
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.ok(!out.notes.join('\n').includes('指派給了多人'));
    env.mock.addMessage({ content: '[ASSIGN] @claude-1 請跟 @claude-2 對齊\nbranch: b' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.match(out.notes.join('\n'), /指派給了多人/);
  });

  test('isolation 無效值會在注意裡提醒；沒寫但有 branch 時預設 worktree', async () => {
    env = await setup();
    await env.join('claude-1');
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nisolation: 共用' });
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.match(out.notes.join('\n'), /isolation「共用」無效/);
    assert.equal(env.readState('claude-1').isolation, null);
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nbranch: feat/x' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(env.readState('claude-1').isolation, 'worktree');
  });

  test('進度提醒從 lastProgressAt 算起，還沒回報過才從 workStartedAt 算起', async () => {
    env = await setup();
    await env.join('claude-1');
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    env.patchState('claude-1', { phase: 'work', workStartedAt: ago(30), lastProgressAt: ago(5) });
    let out = (await env.run(['status', '--as', 'claude-1', '--json'])).json();
    assert.ok(!out.reminders.some((x) => x.includes('[PROGRESS]')));
    env.patchState('claude-1', { lastProgressAt: null });
    out = (await env.run(['status', '--as', 'claude-1', '--json'])).json();
    assert.ok(out.reminders.some((x) => /距上次 \[PROGRESS\] 已 30 分鐘/.test(x)));
  });

  test('切段：``` 後面直接接長內容、同一行開又關的 fence 都不會壞', async () => {
    env = await setup();
    await env.join('claude-1');
    const json = `{${'"k":1,'.repeat(500)}"end":true}`;
    let skip = env.mock.executions.length;
    assert.equal((await env.run(['post', '--as', 'claude-1', `\`\`\`${json}\n結論：採用 A\n\`\`\``])).code, 0);
    let parts = env.mock.executions.slice(skip).map((e) => e.payload.content);
    assert.ok(parts.length >= 2);
    for (const p of parts) {
      assert.ok(p.length <= 2000);
      assert.equal(p.split('\n').filter((l) => /^\s*```/.test(l)).length % 2, 0, p.slice(0, 30));
    }
    assert.ok(parts.join('').replace(/\n\(\d+\/\d+\)/g, '').replace(/\n```\n?/g, '').replace(/\n/g, '').includes(json.slice(-200)));
    skip = env.mock.executions.length;
    assert.equal((await env.run(['post', '--as', 'claude-1', `\`\`\`npm test\`\`\`\n${'x'.repeat(2500)}`])).code, 0);
    parts = env.mock.executions.slice(skip).map((e) => e.payload.content);
    assert.equal(parts.join('').split('npm test').length - 1, 1, '同一行開又關的 fence 不會被重複');
  });
});

describe('createClient 的逾時與限流', () => {
  let server;
  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise((r) => (server ? server.close(r) : r()));
    server = null;
  });

  const listen = async (handler) => {
    server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}/api/v10`;
  };

  test('timeoutMs：伺服器不回應時逾時並重試，最後丟出 DiscordError', { timeout: 10_000 }, async () => {
    const apiBase = await listen(() => {});
    const client = createClient('t', { apiBase, retryBaseMs: 1, timeoutMs: 100 });
    const t0 = Date.now();
    await assert.rejects(client.me(), (e) => e instanceof DiscordError && /逾時/.test(e.message));
    assert.ok(Date.now() - t0 < 5000);
  });

  test('429 沒有 retry_after 也沒有 Retry-After header 時等 1 秒再試', async () => {
    let n = 0;
    const apiBase = await listen((req, res) => {
      n++;
      if (n === 1) {
        res.writeHead(429);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"1"}');
      }
    });
    const client = createClient('t', { apiBase, retryBaseMs: 1 });
    const t0 = Date.now();
    const me = await client.me();
    assert.equal(me.id, '1');
    assert.ok(Date.now() - t0 >= 900, `只等了 ${Date.now() - t0} ms`);
  });
});

describe('webhook 快取', () => {
  let env;
  afterEach(async () => {
    await env.close();
  });

  test('快取檔壞掉時當作沒有快取：重新取得 webhook，錯誤訊息不帶出內容', async () => {
    env = await setup();
    await env.join('claude-1');
    const hookFile = path.join(env.stateDir, 'webhooks', `${env.room.channelId}.json`);
    const token = env.mock.webhooks[0].token;
    fs.writeFileSync(hookFile, `{"id":"1","token":${token}}`);
    const r = await env.run(['post', '--as', 'claude-1', '快取壞了']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stderr.includes(token.slice(0, 10)));
    assert.equal(JSON.parse(fs.readFileSync(hookFile, 'utf8')).token, token);
    assert.ok(webhookMessages(env.mock).length >= 2);
  });
});
