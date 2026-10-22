import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';

describe('wait', () => {
  let env;
  let hook;
  // 其他 agent 經由同一個 webhook 發言。
  const agentSays = (username, content, extra = {}) =>
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username, content, ...extra });

  beforeEach(async () => {
    env = await setup();
    await env.join('claude-1');
    hook = env.mock.webhooks[0];
  });
  afterEach(async () => {
    await env.close();
  });

  test('--timeout 0 沒有新訊息：只查一次，狀態逾時，結束碼 0', async () => {
    const t0 = Date.now();
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(r.code, 0, r.stderr);
    // 只查一次的重點是請求次數（下面驗證）；時間只防「卡住等到逾時」，上限放寬避免機器忙時誤判。
    assert.ok(Date.now() - t0 < 5000);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], '狀態：逾時，沒有新訊息');
    assert.equal(lines[1], '階段：lobby　角色：未指派　討論：0/3');
    const polls = env.mock.requests.filter((q) => q.path.endsWith('/messages') && q.query.includes('after='));
    assert.equal(polls.length, 1);
  });

  test('any：別人的訊息就成立；游標移到最後一則（含自己的），輸出全部累積的訊息', async () => {
    const other = agentSays('gemini-1 (後端)', '[DISCUSS]\n\n我先說');
    await env.run(['post', '--as', 'claude-1', '我自己的話']);
    const mine = env.mock.lastMessage();
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.equal(out.status, 'matched');
    assert.deepEqual(
      out.messages.map((m) => m.id),
      [other.id],
      '自己的訊息不輸出',
    );
    assert.equal(out.messages[0].kind, 'agent');
    assert.equal(out.messages[0].author, 'gemini-1');
    assert.equal(out.messages[0].authorRole, '後端');
    assert.equal(env.readState('claude-1').cursor, mine.id);

    const again = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    assert.equal(again.json().messages.length, 0, '游標已前進，不會重複讀到');
  });

  test('頻道裡新舊兩種顯示名稱格式的自己的訊息都是 self，不會被當成新訊息；別人的新格式照常拆出名稱與角色', async () => {
    agentSays('前端（claude-1）', '新格式的我');
    agentSays('claude-1 (台北人)', '舊格式的我');
    agentSays('先攻（Claude-1）', '大小寫不同的我');
    let r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /^狀態：逾時，沒有新訊息/);
    const other = agentSays('claude-1（claude-2）', '角色剛好叫 claude-1 的別人');
    r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    const out = r.json();
    assert.equal(out.status, 'matched');
    assert.deepEqual(out.messages.map((m) => [m.id, m.kind, m.author, m.authorRole]), [[other.id, 'agent', 'claude-2', 'claude-1']]);
    agentSays('後端（gemini-1）', '別人');
    r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /^\[[^\]]+\] agent 後端（gemini-1）  \(id=\d+\)$/m);
  });

  test('--json 的欄位齊全', async () => {
    env.mock.addMessage({ content: '大家好' });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    for (const key of ['ok', 'status', 'reason', 'phase', 'role', 'round', 'messages', 'notes', 'reminders']) {
      assert.ok(key in out, `缺少 ${key}`);
    }
    assert.deepEqual(out.round, { done: 0, limit: 3 });
    assert.equal(out.reason, '主導者發言');
    const m = out.messages[0];
    for (const key of ['id', 'timestamp', 'kind', 'author', 'content', 'tag', 'title', 'fields', 'body', 'mentionsMe', 'targetsMe', 'replyTo', 'attachments']) {
      assert.ok(key in m, `訊息缺少 ${key}`);
    }
  });

  test('mention：沒提到我就等到逾時，並輸出其他新訊息', async () => {
    agentSays('gemini-1', '@gemini-2 你看一下');
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--until', 'mention']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^狀態：逾時，有 1 則其他新訊息/);
    assert.match(r.stdout, /@gemini-2 你看一下/);
  });

  test('mention：等待中有人 @ 我就提早結束，且之前累積的訊息一起輸出', async () => {
    agentSays('gemini-1', '先講一件事');
    setTimeout(() => agentSays('gemini-1', '@claude-1 換你'), 400);
    const t0 = Date.now();
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '5', '--until', 'mention', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 4000, '應提早結束');
    const out = r.json();
    assert.equal(out.status, 'matched');
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[1].mentionsMe, true);
  });

  test('mention：主導者用 Discord 回覆我的訊息，視為提到我', async () => {
    await env.run(['post', '--as', 'claude-1', '請問這樣可以嗎']);
    const mine = env.mock.lastMessage();
    env.mock.addMessage({ content: '可以', replyTo: mine.id });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
    assert.equal(out.messages[0].replyTo, mine.id);
    assert.equal(out.messages[0].mentionsMe, true);
  });

  test('mention：廣播 @all 與 @角色 也算；轉傳（forward）不算回覆', async () => {
    env.patchState('claude-1', { role: '前端' });
    await env.run(['post', '--as', 'claude-1', '我的訊息']);
    const mine = env.mock.lastMessage();
    env.mock.addMessage({ content: '轉傳', replyTo: mine.id, referenceType: 1 });
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'timeout');
    agentSays('gemini-1', '@前端 請看');
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
    env.mock.addMessage({ content: '＠全體 開會' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
  });

  test('moderator：agent 的訊息不成立，主導者的一般發言就成立', async () => {
    agentSays('gemini-1', '@claude-1 嗨');
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'moderator', '--json'])).json();
    assert.equal(out.status, 'timeout');
    assert.equal(out.messages.length, 1);
    env.mock.addMessage({ content: '我看一下' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'moderator', '--json'])).json();
    assert.equal(out.status, 'matched');
  });

  test('套用指令：TOPIC → ASSIGN → GO @角色（同一批，用套用當下的角色判斷）', async () => {
    env.mock.addMessage({ content: '[TOPIC] 登入\nrepo: /tmp/app\n\n內容' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1 @gemini-1\nrole: 前端\ntask: 登入頁\nisolation: shared\nfiles: src/a.js，src/b.js' });
    env.mock.addMessage({ content: '[GO] @前端' });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^狀態：符合條件（主導者 \[TOPIC\] 對你生效）/);
    assert.match(r.stdout, /新議題「登入」/);
    assert.match(r.stdout, /你被指派/);
    assert.match(r.stdout, /主導者 \[GO\]/);
    const s = env.readState('claude-1');
    assert.equal(s.phase, 'work');
    assert.equal(s.role, '前端');
    assert.equal(s.task, '登入頁');
    assert.equal(s.isolation, 'shared');
    assert.deepEqual(s.files, ['src/a.js', 'src/b.js']);
    assert.ok(s.workStartedAt);
  });

  test('套用指令：沒對到我的 ASSIGN、GO 不生效；agent 發的主導者標籤不算', async () => {
    env.mock.addMessage({ content: '[TOPIC] 議題' });
    env.mock.addMessage({ content: '[ASSIGN] @gemini-1\nrole: 後端' });
    env.mock.addMessage({ content: '[GO] @gemini-1' });
    agentSays('gemini-1', '[GO]');
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    const s = env.readState('claude-1');
    assert.equal(s.phase, 'topic');
    assert.equal(s.role, null);
  });

  test('套用指令：CONTINUE n、STOP、stopped 之後 GO 照常轉換、CLOSE', async () => {
    env.patchState('claude-1', { phase: 'discussion', discussRound: 3, role: '前端', assigned: true });
    env.mock.addMessage({ content: '[CONTINUE] 2 @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    let s = env.readState('claude-1');
    assert.equal(s.discussLimit, 2);
    assert.equal(s.discussRound, 0);
    assert.equal(s.phase, 'discussion');

    env.mock.addMessage({ content: '[STOP]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'stopped');
    assert.equal((await env.run(['post', '--as', 'claude-1', 'stopped 不能 post'])).code, 3);

    env.mock.addMessage({ content: '[GO]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'work');

    env.mock.addMessage({ content: '【close】' });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /議題結束/);
    s = env.readState('claude-1');
    assert.equal(s.phase, 'closed');
    assert.equal((await env.run(['ask', '--as', 'claude-1', 'closed 不能問'])).code, 3);
    assert.equal((await env.run(['leave', '--as', 'claude-1'])).code, 0);
  });

  test('待答問題：回覆 QUESTION 或 [ANSWER] to: 我 都會清除 pendingQuestionId', async () => {
    await env.run(['ask', '--as', 'claude-1', '問題一']);
    const q1 = env.mock.lastMessage();
    env.mock.addMessage({ content: '答案一', replyTo: q1.id });
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
    assert.equal(env.readState('claude-1').pendingQuestionId, null);

    await env.run(['ask', '--as', 'claude-1', '問題二']);
    env.mock.addMessage({ content: '[ANSWER]\nto: Claude-1\n\n答案二' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
    assert.match(out.notes.join('\n'), /\[ANSWER\]/);
    assert.equal(env.readState('claude-1').pendingQuestionId, null);
  });

  test('mention 規則：中文緊接的 @名稱算、email 不算、@角色要有邊界、角色的空白換成 -', async () => {
    const until = async () =>
      (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json().status;
    agentSays('gemini-1', '請@claude-1看一下');
    assert.equal(await until(), 'matched');
    agentSays('gemini-1', '寄信到 me@claude-1.dev');
    assert.equal(await until(), 'timeout');

    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: QA Lead' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').role, 'QA-Lead');
    assert.equal(env.mock.executions.length, 1);
    await env.run(['post', '--as', 'claude-1', 'hi']);
    assert.equal(env.mock.executions.at(-1).payload.username, 'QA-Lead（claude-1）');

    agentSays('gemini-1', '@qa-lead請看');
    assert.equal(await until(), 'matched');
    env.patchState('claude-1', { role: '前端' });
    agentSays('gemini-1', '@前端請看');
    assert.equal(await until(), 'timeout', '@前端請看 的 token 是「前端請看」');
    agentSays('gemini-1', '@前端，請看');
    assert.equal(await until(), 'matched');
  });

  test('mention 最終規則：@ 到 W 看開頭與邊界；任何角色都 @ 得到；@主導者 不要求邊界', async () => {
    const until = async () =>
      (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json().status;
    for (const [role, hit, miss] of [
      ['前端-主', '@前端-主，請看', '@前端 請看'],
      ['UI設計', '@UI設計 請看', '@UI設計師'],
      ['QA-前端', '@qa-前端 看一下', '@qa 看一下'],
      ['qa', '@QA工程師', '@qa-前端'],
    ]) {
      env.patchState('claude-1', { role });
      agentSays('gemini-1', miss);
      assert.equal(await until(), 'timeout', `${role}：${miss}`);
      agentSays('gemini-1', hit);
      assert.equal(await until(), 'matched', `${role}：${hit}`);
    }
    await env.run(['post', '--as', 'claude-1', '請@主導者決定，也請 ＠moderator 看']);
    const mod = env.room.moderatorUserId;
    assert.equal(env.mock.executions.at(-1).payload.content, `[INFO]\n\n請<@${mod}>決定，也請 <@${mod}> 看`);
  });

  test('同一則 [ASSIGN] 指派多人且有 branch：照樣套用，注意加衝突提醒', async () => {
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1 @gemini-1\nbranch: feat/x' });
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(env.readState('claude-1').branch, 'feat/x');
    assert.match(out.notes.join('\n'), /指派給了多人且指定同一個 branch，worktree 模式會衝突，請先用 ask 向主導者確認/);
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nbranch: feat/y' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.ok(!out.notes.join('\n').includes('指派給了多人'));
    env.mock.addMessage({ content: '[ASSIGN] @all\nrole: 大家' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.ok(!out.notes.join('\n').includes('指派給了多人'), '沒有 branch 不提醒');
  });

  test('沒有 @ 的 [GO]、[CONTINUE] 只對已被指派且在 discussion／stopped 的 agent 生效；沒有 @ 的 [STOP] 對一般階段都生效', async () => {
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[GO]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    let s = env.readState('claude-1');
    assert.equal(s.phase, 'topic', '還沒被指派，不受沒 @ 的 GO 影響');
    assert.equal(s.assigned, false);

    env.mock.addMessage({ content: '[CONTINUE]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'topic');

    env.mock.addMessage({ content: '[STOP]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'stopped', '沒 @ 的 STOP 對 topic 階段也生效');

    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端' });
    env.mock.addMessage({ content: '[GO]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    s = env.readState('claude-1');
    assert.equal(s.assigned, true);
    assert.equal(s.phase, 'work');

    env.mock.addMessage({ content: '[CONTINUE]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'work', 'work 階段不受沒 @ 的 CONTINUE 影響');
    env.mock.addMessage({ content: '[CONTINUE] @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'discussion', '有 @ 時不看階段');

    env.patchState('claude-1', { phase: 'closed' });
    env.mock.addMessage({ content: '[STOP]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'closed', 'closed 不受沒 @ 的 STOP 影響');
  });

  test('[ASSIGN] 整組取代分工、記下 assignMessageId／assignBody、discussLimit 設回 null；[CONTINUE] 沒有 n 時也設回 null', async () => {
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端\ntask: 登入頁\nbranch: feat/a\nfiles: a.js\n\n第一份細節' });
    env.mock.addMessage({ content: '[CONTINUE] 5 @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    let s = env.readState('claude-1');
    assert.equal(s.discussLimit, 5);
    assert.equal(s.assignBody, '第一份細節');

    const second = env.mock.addMessage({ content: '[ASSIGN] @claude-1\ntask: 改做文件' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    s = env.readState('claude-1');
    assert.equal(s.role, null, '沒寫 role 就清成 null');
    assert.equal(s.task, '改做文件');
    assert.equal(s.branch, null);
    assert.equal(s.isolation, null);
    assert.equal(s.files, null);
    assert.equal(s.assignMessageId, second.id);
    assert.equal(s.assignBody, null);
    assert.equal(s.discussLimit, null);

    env.mock.addMessage({ content: '[CONTINUE] 2 @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').discussLimit, 2);
    env.mock.addMessage({ content: '[CONTINUE] @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').discussLimit, null, '@claude-1 的 1 不能當成 n');
  });

  test('[STOP] 記下 phaseBeforeStop；停下前是 work 的會被沒 @ 的 GO 拉回，停下前已 done 的不會；連續 STOP 保留最早的階段', async () => {
    env.patchState('claude-1', { phase: 'work', assigned: true });
    env.mock.addMessage({ content: '[STOP]' });
    env.mock.addMessage({ content: '[STOP] @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    let s = env.readState('claude-1');
    assert.equal(s.phase, 'stopped');
    assert.equal(s.phaseBeforeStop, 'work');
    env.mock.addMessage({ content: '[GO]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'work');

    env.patchState('claude-1', { phase: 'done' });
    env.mock.addMessage({ content: '[STOP]' });
    env.mock.addMessage({ content: '[GO]' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    s = env.readState('claude-1');
    assert.equal(s.phase, 'stopped', '停下前已 done，不被沒 @ 的 GO 拉回');
    assert.equal(s.phaseBeforeStop, 'done');
    env.mock.addMessage({ content: '[GO] @claude-1' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'work', '有 @ 時照常生效');
  });

  test('第一行的 <@使用者ID> 不算 @：[GO] <@ID> 視同沒有 @；[ANSWER] to: 可帶 @ 且不分大小寫', async () => {
    env.mock.addMessage({ content: '[TOPIC] t' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端' });
    env.mock.addMessage({ content: `[GO] <@${env.room.moderatorUserId}>` });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').phase, 'work', '<@ID> 不算 @，所以對已指派的 agent 生效');

    await env.run(['ask', '--as', 'claude-1', '問題']);
    env.mock.addMessage({ content: '[ANSWER]\nto: ＠CLAUDE-1\n\n答案' });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
    assert.equal(env.readState('claude-1').pendingQuestionId, null);
  });

  test('[TOPIC] 清除分工、待答問題與 assigned；注意列出作業 repo 來源，不說「純討論」', async () => {
    env.patchState('claude-1', {
      phase: 'work', role: '前端', task: 't', branch: 'b', isolation: 'worktree', files: ['a'],
      assigned: true, pendingQuestionId: '42', discussRound: 2, discussLimit: 5,
      lastProgressAt: new Date().toISOString(), workStartedAt: new Date().toISOString(),
    });
    env.mock.addMessage({ content: '[TOPIC] 第二題' });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    const s = env.readState('claude-1');
    for (const key of ['role', 'task', 'branch', 'isolation', 'files', 'pendingQuestionId', 'lastProgressAt', 'workStartedAt', 'discussLimit']) {
      assert.equal(s[key], null, key);
    }
    assert.equal(s.assigned, false);
    assert.equal(s.discussRound, 0);
    assert.equal(s.phase, 'topic');
    const note = out.notes.join('\n');
    assert.match(note, /作業 repo：未指定，有 branch 分工時用目前目錄/);
    assert.ok(!note.includes('純討論'));

    env.mock.addMessage({ content: '[TOPIC] 第三題\nrepo：/tmp/app\nbase:dev' });
    const again = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.match(again.notes.join('\n'), /作業 repo：\/tmp\/app（\[TOPIC\] 指定）；基準分支：dev/);
  });

  test('待答問題：主導者不加標籤 @ 我的名稱會清除；@角色、@all 不會；回覆已掉出最近 50 則的問題也認得', async () => {
    env.patchState('claude-1', { role: '前端' });
    await env.run(['ask', '--as', 'claude-1', '問題']);
    const q = env.mock.lastMessage();
    env.mock.addMessage({ content: '@前端 等一下' });
    env.mock.addMessage({ content: '@all 先休息' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').pendingQuestionId, q.id);

    env.patchState('claude-1', { ownMessageIds: [] });
    env.mock.addMessage({ content: '回覆舊問題', replyTo: q.id });
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'matched');
    assert.equal(env.readState('claude-1').pendingQuestionId, null);

    await env.run(['ask', '--as', 'claude-1', '問題二']);
    env.mock.addMessage({ content: '@claude-1 用 A' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').pendingQuestionId, null);
  });

  test('emptyWaitSince：--timeout > 0 才開始計時；別人一般發言會清掉，別的 agent 的 JOIN／LEAVE／IDLE 不會', async () => {
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').emptyWaitSince, null, '--timeout 0 不計時');
    await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    const since = env.readState('claude-1').emptyWaitSince;
    assert.ok(since);
    await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    assert.equal(env.readState('claude-1').emptyWaitSince, since, '連續沒訊息時保留最早的時間');
    agentSays('gemini-1', '[JOIN] gemini-1\nvendor: gemini');
    agentSays('gemini-2', '[LEAVE] gemini-2');
    agentSays('gemini-3', '[IDLE] gemini-3');
    env.mock.addMessage({ author: 'human', content: '[JOIN] 人類也發了 JOIN' });
    env.mock.addMessage({ content: '[LEAVE] 主導者發的 LEAVE' });
    await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    assert.equal(env.readState('claude-1').emptyWaitSince, since, '進出房與 IDLE 不重設');
    agentSays('gemini-1', 'hi');
    await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    assert.equal(env.readState('claude-1').emptyWaitSince, null);
  });

  test('IDLE 只在 --timeout > 0 且不在 work 階段觸發；只有別人進出房時照樣觸發；[GO] 重設計時', async () => {
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    env.patchState('claude-1', { emptyWaitSince: old });
    let out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(out.status, 'timeout', '--timeout 0 不觸發');

    env.patchState('claude-1', { phase: 'work', assigned: true });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--json'])).json();
    assert.equal(out.status, 'timeout', 'work 階段不觸發');

    env.patchState('claude-1', { phase: 'discussion' });
    env.mock.addMessage({ content: '[GO]' });
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--until', 'mention', '--json'])).json();
    assert.equal(out.phase, 'work');
    assert.equal(env.readState('claude-1').emptyWaitSince, null, '進入 work 重設');

    env.patchState('claude-1', { phase: 'discussion', emptyWaitSince: old });
    agentSays('gemini-1', '[JOIN] gemini-1');
    out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--until', 'mention', '--json'])).json();
    assert.equal(out.status, 'idle', '只有別人進房，仍然算無人回應');
    assert.equal(out.messages.length, 1);
  });

  test('無人回應超過 idleLimitMin：自動發 [IDLE]，階段改為 idle，狀態回報 idle', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    env.patchState('claude-1', { emptyWaitSince: twoHoursAgo });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.status, 'idle');
    assert.equal(out.phase, 'idle');
    const last = env.mock.lastMessage();
    assert.match(last.content, /^\[IDLE\] claude-1/);
    const s = env.readState('claude-1');
    assert.equal(s.phase, 'idle');
    assert.ok(s.ownMessageIds.includes(last.id));
    assert.equal((await env.run(['post', '--as', 'claude-1', 'idle 不能 post'])).code, 3);

    const text = await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    assert.match(text.stdout, /^狀態：逾時，沒有新訊息/, '已經 idle 就不重發');
    assert.equal(env.mock.messages.filter((m) => m.content.startsWith('[IDLE]')).length, 1);
  });

  test('自動 [IDLE] 送出途中被 clear：寫明 [IDLE] 已送出、不要重發（結束碼 2），本機紀錄照寫', async () => {
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    env.mock.delay({ method: 'POST', path: /^\/webhooks\//, ms: 3000 });
    const executes = () => env.mock.requests.filter((q) => q.method === 'POST' && q.path.includes('/webhooks/')).length;
    const before = executes();
    const waiting = env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    for (let i = 0; i < 200 && executes() === before; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal((await env.run(['clear', '--yes'])).code, 0);
    const r = await waiting;
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /^agentchat: 自動 \[IDLE\] 已送出（訊息 ID：\d+），不要重發；但更新本機狀態失敗：claude-1 的本機狀態已被主導者用 agentchat clear 清除/);
    const sent = env.mock.lastMessage();
    assert.match(sent.content, /^\[IDLE\] claude-1/);
    const log = fs.readFileSync(path.join(env.stateDir, 'logs', `${env.mock.config.channelId}.jsonl`), 'utf8');
    assert.ok(log.includes(sent.id), '本機紀錄照寫');
  });

  test('無人回應但有別人一般發言：計時被重設，不發 [IDLE]（即使不符合 --until 條件）', async () => {
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    agentSays('gemini-1', '我還在');
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--until', 'moderator', '--json'])).json();
    assert.equal(out.status, 'timeout');
    assert.ok(!env.mock.messages.some((m) => m.content.startsWith('[IDLE]')));
    assert.equal(env.readState('claude-1').emptyWaitSince, null);
  });

  test('文字輸出：「idle」第一行、提醒段落', async () => {
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '1']);
    assert.match(r.stdout, /^狀態：已自動發出 \[IDLE\]\n階段：idle/);
    assert.match(r.stdout, /提醒\n- 已發過 \[IDLE\]/);
  });

  test('附檔只顯示檔名與大小，提示用 download', async () => {
    env.mock.addMessage({ content: '看圖', attachments: [{ filename: 'a.png', data: Buffer.alloc(2048), content_type: 'image/png' }] });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /附檔：a\.png（2 KB）→ agentchat download --as claude-1 \d+/);
    const anon = await env.run(['read', '--last', '1']);
    assert.match(anon.stdout, /→ agentchat download --as <你的名稱> \d+/);
    const out = (await env.run(['read', '--as', 'claude-1', '--last', '1', '--json'])).json();
    assert.equal(out.messages[0].attachments[0].url, undefined, 'JSON 不帶會過期的連結');
  });

  test('參數與階段：--timeout 超出範圍、--until 不對 → 2；已 leave → 3；沒 join → 2', async () => {
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--timeout', '541'])).code, 2);
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--timeout', '-1'])).code, 2);
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--until', 'all'])).code, 2);
    assert.equal((await env.run(['wait', '--as', 'nobody', '--timeout', '0'])).code, 2);
    await env.run(['leave', '--as', 'claude-1']);
    const left = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(left.code, 3);
    assert.match(left.stderr, /你已離開這個房間；除非開這個 session 的使用者要求，不要重新 join/);
  });

  test('Discord 限流 429：依 retry_after 重試後成功', async () => {
    env.mock.addMessage({ content: 'hi' });
    env.mock.rateLimit({ method: 'GET', path: /\/messages$/, retryAfter: 0.05, times: 2 });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().status, 'matched');
  });
});
