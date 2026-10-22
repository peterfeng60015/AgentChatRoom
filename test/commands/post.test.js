import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, webhookMessages } from './helpers.js';

const MB = 1024 * 1024;

// 進房並直接把狀態調成指定階段，省去主導者指令的往返。
async function joined(env, patch = {}, name = 'claude-1') {
  await env.join(name);
  return env.patchState(name, patch);
}

describe('post 與發文共通處理', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('預設 [INFO]，帶標題、欄位；@moderator 換成真正的 mention，只放行主導者', async () => {
    await joined(env);
    const r = await env.run([
      'post', '--as', 'claude-1', '--title', '小結', '--field', 'branch=feat/x', '--field', 'ETA=10 分',
      '@moderator 請看，也通知 ＠主導者；@everyone 不該生效',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const ex = env.mock.executions.at(-1);
    assert.equal(
      ex.payload.content,
      `[INFO] 小結\nbranch: feat/x\neta: 10 分\n\n<@${env.room.moderatorUserId}> 請看，也通知 <@${env.room.moderatorUserId}>；@everyone 不該生效`,
    );
    assert.deepEqual(ex.payload.allowed_mentions, { parse: [], users: [env.room.moderatorUserId] });
    assert.match(r.stdout, /已送出 \[INFO\]，訊息 ID：\d+/);
    const state = env.readState('claude-1');
    assert.ok(state.ownMessageIds.includes(ex.id));
    assert.equal(state.emptyWaitSince, null);
  });

  test('內文只有位置參數是 - 時才讀 stdin；內文自帶 [INFO]／[DISCUSS] 標籤列時照原樣送出', async () => {
    await joined(env);
    let r = await env.run(['post', '--as', 'claude-1', '-'], { input: '從 stdin 來的內文\n第二行\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '[INFO]\n\n從 stdin 來的內文\n第二行');

    const before = env.mock.executions.length;
    r = await env.run(['post', '--as', 'claude-1'], { input: '沒有 - 就不讀 stdin' });
    assert.equal(r.code, 2, '沒有內文');
    r = await env.run(['discuss', '--as', 'claude-1'], { input: '也不讀' });
    assert.equal(r.code, 2);
    assert.equal(env.mock.executions.length, before);

    r = await env.run(['post', '--as', 'claude-1', '【info】 小結\nbranch: x\n\n原樣']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '【info】 小結\nbranch: x\n\n原樣');
  });

  test('--body-file 讀檔當內文；和位置參數或 - 同時給 → 2；檔案讀不到 → 2', async () => {
    await joined(env, { phase: 'discussion' });
    const file = path.join(env.root, 'body.md');
    fs.writeFileSync(file, '有 "引號" 與 $(不會執行) 的內文\n第二行\n');
    let r = await env.run(['discuss', '--as', 'claude-1', '--body-file', file]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '[DISCUSS]\n\n有 "引號" 與 $(不會執行) 的內文\n第二行');
    const before = env.mock.executions.length;
    r = await env.run(['post', '--as', 'claude-1', '--body-file', file, '另外的內文']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /三選一/);
    r = await env.run(['post', '--as', 'claude-1', '--body-file', file, '-'], { input: 'stdin' });
    assert.equal(r.code, 2);
    r = await env.run(['ask', '--as', 'claude-1', '--body-file', path.join(env.root, 'none.md')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /讀不到 --body-file/);
    assert.equal(env.mock.executions.length, before);
  });

  test('post 只接受 INFO、DISCUSS：其他 agent 標籤 → 結束碼 2 並提示對應指令', async () => {
    await joined(env, { phase: 'work' });
    const before = env.mock.executions.length;
    let r = await env.run(['post', '--as', 'claude-1', '--tag', 'progress', '50%']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /請改用 agentchat progress/);
    r = await env.run(['post', '--as', 'claude-1', '[QUESTION] 偷問']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /請改用 agentchat ask/);
    r = await env.run(['post', '--as', 'claude-1', '--tag', 'IDLE', 'x']);
    assert.equal(r.code, 2);
    r = await env.run(['post', '--as', 'claude-1', '[DONE] 偷完成']);
    assert.equal(r.code, 2);
    assert.equal(env.mock.executions.length, before);
    assert.equal(env.readState('claude-1').phase, 'work');
  });

  test('拒絕主導者標籤：--tag 或內文標籤 → 結束碼 3，不送出', async () => {
    await joined(env);
    const before = env.mock.executions.length;
    let r = await env.run(['post', '--as', 'claude-1', '--tag', 'topic', '新議題']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /主導者專用標籤/);
    r = await env.run(['post', '--as', 'claude-1', '［GO］ 開工']);
    assert.equal(r.code, 3);
    r = await env.run(['discuss', '--as', 'claude-1', '[ANSWER] @claude-2 好']);
    assert.equal(r.code, 3);
    assert.equal(env.mock.executions.length, before);
  });

  test('參數錯誤：不認得的標籤、欄位、沒有內容 → 結束碼 2', async () => {
    await joined(env);
    assert.equal((await env.run(['post', '--as', 'claude-1', '--tag', 'FOO', 'x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'claude-1', '--field', 'foo=bar', 'x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'claude-1', '--field', 'nokey', 'x'])).code, 2);
    assert.equal((await env.run(['post', '--as', 'claude-1'])).code, 2);
  });

  test('超過 2000 字切段：每段 ≤ 2000、結尾 (i/n)、只有第一則有標籤列、附檔在最後一則', async () => {
    await joined(env);
    const file = path.join(env.root, 'note.txt');
    fs.writeFileSync(file, 'hello');
    const body = Array.from({ length: 120 }, (_, i) => `第 ${i} 行：${'內容'.repeat(10)}`).join('\n');
    const skip = env.mock.executions.length;
    const r = await env.run(['post', '--as', 'claude-1', '--file', file, body]);
    assert.equal(r.code, 0, r.stderr);
    const ex = env.mock.executions.slice(skip);
    assert.ok(ex.length >= 2, `應切成多則，實際 ${ex.length}`);
    ex.forEach((e, i) => {
      assert.ok(e.payload.content.length <= 2000);
      assert.ok(e.payload.content.endsWith(`(${i + 1}/${ex.length})`));
      assert.equal(e.payload.content.startsWith('[INFO]'), i === 0);
      assert.equal(e.files.length, i === ex.length - 1 ? 1 : 0);
    });
    const state = env.readState('claude-1');
    for (const e of ex) assert.ok(state.ownMessageIds.includes(e.id));
    assert.match(r.stdout, /切成 \d+ 則/);
  });

  test('切段時 code fence 兩邊補成對，fence 內的超長單行也一樣；不留空區塊', async () => {
    await joined(env);
    const body = `說明\n\`\`\`js\n${'x'.repeat(4500)}\nconst a = 1;\n\`\`\`\n結尾`;
    const skip = env.mock.executions.length;
    const r = await env.run(['post', '--as', 'claude-1', body]);
    assert.equal(r.code, 0, r.stderr);
    const parts = env.mock.executions.slice(skip).map((e) => e.payload.content);
    assert.ok(parts.length >= 3);
    for (const p of parts) {
      assert.ok(p.length <= 2000);
      const fences = p.split('\n').filter((l) => /^\s*```/.test(l));
      assert.equal(fences.length % 2, 0, `fence 不成對：${p.slice(0, 40)}`);
      assert.ok(!/```js\n```/.test(p), '不該有空的 code block');
    }
    assert.equal(parts.map((p) => p.replace(/\n\(\d+\/\d+\)$/, '')).join('').replace(/```(js)?/g, '').replace(/\n/g, '').length,
      `[INFO]說明${'x'.repeat(4500)}const a = 1;結尾`.length);
  });

  test('超過 longTextChars：只送表頭 + 前 500 字 + 提示，全文附 message.md', async () => {
    await env.close();
    env = await setup({ room: { longTextChars: 3000 } });
    await joined(env, { phase: 'work', branch: 'feat/x' });
    const body = 'A'.repeat(600) + 'B'.repeat(3000);
    const skip = env.mock.executions.length;
    const r = await env.run(['progress', '--as', 'claude-1', '--percent', '40', body]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.length, skip + 1);
    const ex = env.mock.executions[skip];
    assert.equal(ex.payload.content, `[PROGRESS] 40%\npercent: 40\nbranch: feat/x\n\n${'A'.repeat(500)}\n\n（全文見附檔 message.md）`);
    assert.equal(ex.files.length, 1);
    assert.equal(ex.files[0].filename, 'message.md');
    assert.equal(ex.files[0].data.toString('utf8'), `[PROGRESS] 40%\npercent: 40\nbranch: feat/x\n\n${body}`);
  });

  test('附檔上限：超過單檔 maxFileMB、超過 10 個、總和超過 25 MB → 結束碼 2', async () => {
    await env.close();
    env = await setup({ room: { maxFileMB: 1 } });
    await joined(env);
    const big = path.join(env.root, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(MB + 1));
    let r = await env.run(['post', '--as', 'claude-1', '--file', big, 'x']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /單檔上限 1 MB/);

    const small = path.join(env.root, 'a.png');
    fs.writeFileSync(small, 'png');
    const eleven = Array.from({ length: 11 }, () => ['--file', small]).flat();
    r = await env.run(['post', '--as', 'claude-1', ...eleven, 'x']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /最多 10 個/);

    r = await env.run(['post', '--as', 'claude-1', '--file', path.join(env.root, 'missing.txt'), 'x']);
    assert.equal(r.code, 2);
    assert.equal(env.mock.executions.length, 1, '只有 join 的那一則');
  });

  test('附檔總和超過 maxUploadMB（預設 10）→ 結束碼 2；圖片給正確的 content type', async () => {
    await env.close();
    env = await setup({ room: { maxFileMB: 10 } });
    await joined(env);
    const files = [];
    for (let i = 0; i < 3; i++) {
      const f = path.join(env.root, `part${i}.bin`);
      fs.writeFileSync(f, Buffer.alloc(9 * MB));
      files.push('--file', f);
    }
    let r = await env.run(['post', '--as', 'claude-1', ...files, 'x']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /總和超過 10 MB/);

    const img = path.join(env.root, 'shot.PNG');
    fs.writeFileSync(img, 'fake');
    r = await env.run(['post', '--as', 'claude-1', '--file', img, '截圖']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).files[0].content_type, 'image/png');
  });

  test('未讀提示：游標之後有別人的訊息時提示先 wait --timeout 0', async () => {
    await joined(env);
    env.mock.addMessage({ author: 'human', content: '有人說話' });
    const r = await env.run(['post', '--as', 'claude-1', 'hi', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().unread, 1);
    const t = await env.run(['post', '--as', 'claude-1', 'hi again']);
    assert.match(t.stdout, /未讀：1 則，先用 agentchat wait --as claude-1 --timeout 0 讀取/);
  });

  test('還沒 join → 結束碼 2；leave 之後不能再發言 → 結束碼 3', async () => {
    let r = await env.run(['post', '--as', 'claude-9', 'hi']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /還沒進房/);
    await joined(env);
    env.mock.addMessage({ author: 'human', content: '未讀的訊息' });
    r = await env.run(['leave', '--as', 'claude-1', '先走了']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '[LEAVE] claude-1\n\n先走了');
    assert.ok(!r.stdout.includes('未讀'), 'leave 不印未讀提示');
    assert.match(r.stdout, /已離開，不要再 wait 或重新 join/);
    assert.ok(!/請重新 agentchat join/.test(r.stdout));
    const state = env.readState('claude-1');
    assert.equal(state.left, true);
    assert.equal(state.phase, 'left');
    r = await env.run(['post', '--as', 'claude-1', 'hi']);
    assert.equal(r.code, 3);
    r = await env.run(['leave', '--as', 'claude-1']);
    assert.equal(r.code, 3);
  });
});

describe('discuss、ack、ask、progress、done 的階段與欄位', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('discuss：不在 discussion 階段 → 結束碼 3', async () => {
    await joined(env);
    const r = await env.run(['discuss', '--as', 'claude-1', '我覺得…']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /目前階段是 lobby，不能用 discuss/);
  });

  test('discuss：輪數上限（房間預設 3）後拒絕；post --tag DISCUSS 一樣計數', async () => {
    await joined(env, { phase: 'discussion', role: '前端' });
    for (let i = 1; i <= 2; i++) {
      const r = await env.run(['discuss', '--as', 'claude-1', `第 ${i} 則`]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(env.readState('claude-1').discussRound, i);
    }
    let r = await env.run(['post', '--as', 'claude-1', '--tag', 'discuss', '第 3 則']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.readState('claude-1').discussRound, 3);
    assert.equal(env.mock.executions.at(-1).payload.content, '[DISCUSS]\n\n第 3 則');
    assert.equal(env.mock.executions.at(-1).payload.username, 'claude-1 (前端)');

    r = await env.run(['discuss', '--as', 'claude-1', '第 4 則']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /已達上限/);
    r = await env.run(['post', '--as', 'claude-1', '[DISCUSS] 偷渡']);
    assert.equal(r.code, 3);
    assert.equal(env.readState('claude-1').discussRound, 3);
  });

  test('discuss：上限依序取 discussLimit、議題 rounds、房間預設', async () => {
    await joined(env, { phase: 'discussion', topic: { id: '1', title: 't', fields: { rounds: '1' }, body: '' } });
    assert.equal((await env.run(['discuss', '--as', 'claude-1', 'a'])).code, 0);
    assert.equal((await env.run(['discuss', '--as', 'claude-1', 'b'])).code, 3);
    env.patchState('claude-1', { discussLimit: 2 });
    assert.equal((await env.run(['discuss', '--as', 'claude-1', 'c'])).code, 0);
    assert.equal((await env.run(['discuss', '--as', 'claude-1', 'd'])).code, 3);
  });

  test('discuss 的內文是別的 agent 標籤 → 結束碼 2；缺內文 → 結束碼 2', async () => {
    await joined(env, { phase: 'discussion' });
    assert.equal((await env.run(['discuss', '--as', 'claude-1', '[INFO] 不是討論'])).code, 2);
    assert.equal((await env.run(['discuss', '--as', 'claude-1'])).code, 2);
  });

  test('ack：欄位 role、branch 取自狀態；只在 discussion 階段可用', async () => {
    await joined(env, { phase: 'topic' });
    assert.equal((await env.run(['ack', '--as', 'claude-1', '收到'])).code, 3);
    env.patchState('claude-1', { phase: 'discussion', role: '前端', branch: 'feat/login' });
    const r = await env.run(['ack', '--as', 'claude-1', '我負責登入頁']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '[ACK]\nrole: 前端\nbranch: feat/login\n\n我負責登入頁');
    assert.equal(env.readState('claude-1').discussRound, 0, 'ack 不計入輪數');
  });

  test('ask：第一行真的 @ 主導者、allowed_mentions 放行主導者、記下 pendingQuestionId', async () => {
    await joined(env, { phase: 'stopped' });
    const r = await env.run(['ask', '--as', 'claude-1', '要用哪個資料庫？\nA 或 B']);
    assert.equal(r.code, 0, r.stderr);
    const ex = env.mock.executions.at(-1);
    const mod = env.room.moderatorUserId;
    assert.equal(ex.payload.content, `[QUESTION] <@${mod}> 要用哪個資料庫？\n\nA 或 B`);
    assert.deepEqual(ex.payload.allowed_mentions.users, [mod]);
    assert.deepEqual(env.mock.lastMessage().mentions, [{ id: mod }], '假 Discord 依 allowed_mentions 算出會通知主導者');
    assert.equal(env.readState('claude-1').pendingQuestionId, ex.id);
    assert.match(r.stdout, /接著用 agentchat wait --as claude-1 --until mention --timeout 2 等主導者回答/);
  });

  test('ask：內文自帶 [QUESTION] 標籤列時補上主導者 mention；closed 階段不能問', async () => {
    await joined(env);
    const r = await env.run(['ask', '--as', 'claude-1', '[QUESTION] 資料庫\n\n用哪個？']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, `[QUESTION] <@${env.room.moderatorUserId}> 資料庫\n\n用哪個？`);
    env.patchState('claude-1', { phase: 'closed' });
    assert.equal((await env.run(['ask', '--as', 'claude-1', '還能問嗎'])).code, 3);
    env.patchState('claude-1', { phase: 'lobby' });
    assert.equal((await env.run(['ask', '--as', 'claude-1', '[TOPIC] 偷渡'])).code, 3, '問題第一行是主導者標籤也要拒絕');
    assert.equal((await env.run(['ask', '--as', 'claude-1', '[INFO] 不是問題'])).code, 2);
    const one = await env.run(['ask', '--as', 'claude-1', '單行問題']);
    assert.equal(one.code, 0, one.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, `[QUESTION] <@${env.room.moderatorUserId}> 單行問題`);
  });

  test('progress：只在 work 階段；--percent 必填且 0 到 100；更新 lastProgressAt', async () => {
    await joined(env, { phase: 'discussion' });
    assert.equal((await env.run(['progress', '--as', 'claude-1', '--percent', '10', 'x'])).code, 3);
    env.patchState('claude-1', { phase: 'work', branch: 'feat/a' });
    assert.equal((await env.run(['progress', '--as', 'claude-1', 'x'])).code, 2);
    assert.equal((await env.run(['progress', '--as', 'claude-1', '--percent', '101', 'x'])).code, 2);
    assert.equal((await env.run(['progress', '--as', 'claude-1', '--percent', 'abc', 'x'])).code, 2);
    const r = await env.run(['progress', '--as', 'claude-1', '--percent', '0', '--eta', '約 20 分', '開始了']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.content, '[PROGRESS] 0%\npercent: 0\neta: 約 20 分\nbranch: feat/a\n\n開始了');
    assert.ok(env.readState('claude-1').lastProgressAt);
  });

  test('done：只在 work 階段；branch 預設取自狀態；階段改為 done', async () => {
    await joined(env, { phase: 'work', branch: 'feat/a' });
    const r = await env.run(['done', '--as', 'claude-1', '--commit', 'abc1234', '--worktree', '/tmp/wt', '完成登入頁']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      env.mock.executions.at(-1).payload.content,
      '[DONE]\nbranch: feat/a\nworktree: /tmp/wt\ncommit: abc1234\n\n完成登入頁',
    );
    assert.equal(env.readState('claude-1').phase, 'done');
    assert.equal((await env.run(['done', '--as', 'claude-1', '再一次'])).code, 3);
    assert.equal((await env.run(['post', '--as', 'claude-1', 'done 之後還能 post'])).code, 0);
  });

  test('長名稱加角色：顯示名稱截到 80 字', async () => {
    const name = 'a'.repeat(31);
    await joined(env, { role: '很長的角色'.repeat(10) }, name);
    const r = await env.run(['post', '--as', name, 'hi']);
    assert.equal(r.code, 0, r.stderr);
    const username = env.mock.executions.at(-1).payload.username;
    assert.ok(username.length <= 80);
    assert.ok(username.startsWith(`${name} (`) && username.endsWith(')'));
    assert.ok(webhookMessages(env.mock).length >= 2);
  });
});
