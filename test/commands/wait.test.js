import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(Date.now() - t0 < 1500);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], '狀態：逾時，沒有新訊息');
    assert.equal(lines[1], '階段：lobby｜角色：未指派｜討論輪數：0/3');
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
    env.patchState('claude-1', { phase: 'discussion', discussRound: 3, role: '前端' });
    env.mock.addMessage({ content: '[CONTINUE] @claude-1 2' });
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

  test('emptyWaitSince：開始時設定，有別人的新訊息就清掉', async () => {
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    const since = env.readState('claude-1').emptyWaitSince;
    assert.ok(since);
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').emptyWaitSince, since, '連續沒訊息時保留最早的時間');
    agentSays('gemini-1', 'hi');
    await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.equal(env.readState('claude-1').emptyWaitSince, null);
  });

  test('無人回應超過 idleLimitMin：自動發 [IDLE]，階段改為 idle，狀態回報 idle', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    env.patchState('claude-1', { emptyWaitSince: twoHoursAgo });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
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

    const text = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(text.stdout, /^狀態：逾時，沒有新訊息/, '已經 idle 就不重發');
    assert.equal(env.mock.messages.filter((m) => m.content.startsWith('[IDLE]')).length, 1);
  });

  test('無人回應但有新訊息：不發 [IDLE]', async () => {
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    agentSays('gemini-1', '我還在');
    const out = (await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json'])).json();
    assert.equal(out.status, 'matched');
    assert.ok(!env.mock.messages.some((m) => m.content.startsWith('[IDLE]')));
  });

  test('文字輸出：「idle」第一行、提醒段落', async () => {
    env.patchState('claude-1', { emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /^狀態：已自動發出 \[IDLE\]\n階段：idle/);
    assert.match(r.stdout, /提醒\n- 已發過 \[IDLE\]/);
  });

  test('附檔只顯示檔名與大小，提示用 download', async () => {
    env.mock.addMessage({ content: '看圖', attachments: [{ filename: 'a.png', data: Buffer.alloc(2048), content_type: 'image/png' }] });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0']);
    assert.match(r.stdout, /附檔：a\.png（2 KB）→ agentchat download \d+/);
    const out = (await env.run(['read', '--as', 'claude-1', '--last', '1', '--json'])).json();
    assert.equal(out.messages[0].attachments[0].url, undefined, 'JSON 不帶會過期的連結');
  });

  test('參數與階段：--timeout 超出範圍、--until 不對 → 2；已 leave → 3；沒 join → 2', async () => {
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--timeout', '541'])).code, 2);
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--timeout', '-1'])).code, 2);
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--until', 'all'])).code, 2);
    assert.equal((await env.run(['wait', '--as', 'nobody', '--timeout', '0'])).code, 2);
    await env.run(['leave', '--as', 'claude-1']);
    assert.equal((await env.run(['wait', '--as', 'claude-1', '--timeout', '0'])).code, 3);
  });

  test('Discord 限流 429：依 retry_after 重試後成功', async () => {
    env.mock.addMessage({ content: 'hi' });
    env.mock.rateLimit({ method: 'GET', path: /\/messages$/, retryAfter: 0.05, times: 2 });
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '0', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().status, 'matched');
  });
});
