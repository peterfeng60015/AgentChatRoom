import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, webhookMessages } from './helpers.js';

describe('join', () => {
  let env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.close();
  });

  test('新進房：建立 webhook、狀態檔、游標設為最新訊息，發 [JOIN] 帶欄位', async () => {
    const before = env.mock.addMessage({ author: 'human', content: '大家好' });
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--model', 'opus', '--host', 'mac-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /已進房：claude-1/);
    assert.match(r.stdout, /階段：lobby/);

    assert.equal(env.mock.webhooks.length, 1, '應建立一個 webhook');
    const sent = webhookMessages(env.mock);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].author.username, 'claude-1');
    assert.equal(sent[0].content, '[JOIN] claude-1\nvendor: claude\nmodel: opus\nhost: mac-1');

    const state = env.readState('claude-1');
    assert.equal(state.version, 1);
    assert.equal(state.cursor, before.id);
    assert.equal(state.phase, 'lobby');
    assert.equal(state.vendor, 'claude');
    assert.equal(state.model, 'opus');
    assert.deepEqual(state.ownMessageIds, [sent[0].id]);
    assert.equal(state.left, false);

    // webhook token 存在 0600 的快取檔，不會出現在輸出裡。
    const hookFile = `${env.stateDir}/webhooks/${env.room.channelId}.json`;
    assert.equal(fs.statSync(hookFile).mode & 0o777, 0o600);
    assert.ok(!r.stdout.includes(env.mock.webhooks[0].token));
  });

  test('空頻道：游標用現在時間的 snowflake；沒給的欄位不寫', async () => {
    const r = await env.run(['join', '--as', 'gemini-1', '--vendor', 'gemini']);
    assert.equal(r.code, 0, r.stderr);
    const state = env.readState('gemini-1');
    assert.match(state.cursor, /^\d+$/);
    assert.equal(webhookMessages(env.mock)[0].content, '[JOIN] gemini-1\nvendor: gemini');
  });

  test('--model、--host 太長或含換行：壓成一行並截到 100 字，[JOIN] 不會超過 Discord 上限', async () => {
    const r = await env.run(['join', '--as', 'codex-1', '--vendor', 'codex', '--model', `gpt\n${'x'.repeat(3000)}`, '--host', 'h'.repeat(500)]);
    assert.equal(r.code, 0, r.stderr);
    const content = webhookMessages(env.mock)[0].content;
    const [, , model, host] = content.split('\n');
    assert.equal(model, `model: gpt ${'x'.repeat(96)}`);
    assert.equal(host, `host: ${'h'.repeat(100)}`);
    assert.equal(env.readState('codex-1').model.length, 100);
  });

  test('本機同名使用中：沒帶 --resume／--force → 結束碼 3，寫明使用中與最後活動時間，不發訊息', async () => {
    await env.join('claude-1');
    const count = env.mock.messages.length;
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /這個名稱在本機使用中：claude-1（最後活動時間 \d\d\/\d\d \d\d:\d\d:\d\d/);
    assert.match(r.stderr, /新開的 session 請換名稱；確定要接手這個身分才加 --resume/);
    assert.equal(env.mock.messages.length, count);
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--resume', '--force'])).code, 2);
  });

  test('--resume：接手既有身分，保留角色、階段與游標，不重發 [JOIN]，第一行固定', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'discussion', role: '前端', cursor: '123' });
    const count = env.mock.messages.length;
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--resume']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0], '重新連線：接手既有身分 claude-1，沒有發 [JOIN]');
    assert.match(r.stdout, /階段：discussion　角色：前端/);
    assert.equal(env.mock.messages.length, count, '不應再發訊息');
    const state = env.readState('claude-1');
    assert.equal(state.phase, 'discussion');
    assert.equal(state.role, '前端');
    assert.equal(state.cursor, '123');
  });

  test('--force：捨棄本機舊狀態，建立新身分並發 [JOIN]', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { phase: 'work', role: '前端' });
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--force']);
    assert.equal(r.code, 0, r.stderr);
    const state = env.readState('claude-1');
    assert.equal(state.phase, 'lobby');
    assert.equal(state.role, null);
    assert.equal(state.assigned, false);
    assert.equal(webhookMessages(env.mock).filter((m) => m.content.startsWith('[JOIN]')).length, 2);
  });

  test('--resume 但沒有可接手的身分（沒有狀態檔或已 leave）→ 結束碼 3，不發訊息', async () => {
    let r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--resume']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /沒有可接手的身分，請不帶 --resume 進房/);
    assert.equal(env.mock.messages.length, 0);
    await env.join('claude-1');
    await env.run(['leave', '--as', 'claude-1']);
    r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--resume']);
    assert.equal(r.code, 3);
  });

  test('已 leave 的狀態再 join：建立新狀態並發 [JOIN]', async () => {
    await env.join('claude-1');
    env.patchState('claude-1', { role: '舊角色' });
    assert.equal((await env.run(['leave', '--as', 'claude-1'])).code, 0);
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    const state = env.readState('claude-1');
    assert.equal(state.left, false);
    assert.equal(state.phase, 'lobby');
    assert.equal(state.role, null);
    assert.equal(webhookMessages(env.mock).filter((m) => m.content.startsWith('[JOIN]')).length, 2);
  });

  test('名稱衝突：24 小時內別人用過且最後不是 LEAVE → 結束碼 3；--force 可略過', async () => {
    const hook = env.mock.addWebhook({ name: 'agentchat' });
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: 'Claude-1 (後端)', content: '[DISCUSS]\n\n我覺得…' });
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /24 小時內有人用過/);
    assert.ok(!fs.existsSync(env.agentFile('claude-1')), '被拒絕時不建立狀態檔');

    const forced = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--force']);
    assert.equal(forced.code, 0, forced.stderr);
  });

  test('名稱衝突：新格式 角色（名稱）的訊息也認得；角色剛好是我的名稱不算', async () => {
    const hook = env.mock.addWebhook({ name: 'agentchat' });
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: 'claude-1（gemini-1）', content: '[DISCUSS]\n\n角色叫 claude-1' });
    let r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: '後端（Codex-1）', content: '[DISCUSS]\n\n我覺得…' });
    r = await env.run(['join', '--as', 'codex-1', '--vendor', 'codex']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /24 小時內有人用過/);
  });

  test('名稱衝突：最後一則是 [LEAVE]、超過 24 小時、或是別的 webhook，都不算衝突', async () => {
    const hook = env.mock.addWebhook({ name: 'agentchat' });
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: 'claude-1', content: '[LEAVE] claude-1' });
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: 'claude-2', content: '[INFO] hi', timestamp: old });
    env.mock.addMessage({ author: 'webhook', webhookId: '999999999999999999', username: 'claude-3', content: '[INFO] 別的 webhook' });
    for (const name of ['claude-1', 'claude-2', 'claude-3']) {
      const r = await env.run(['join', '--as', name, '--vendor', 'claude']);
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    }
  });

  test('有進行中的議題：印出議題，依序套用對我生效的 [ASSIGN]，[JOIN] 用新角色', async () => {
    env.mock.addMessage({ content: '[TOPIC] 舊議題' });
    env.mock.addMessage({ content: '[CLOSE]' });
    env.mock.addMessage({ content: '[TOPIC] 登入功能\nrepo: /tmp/app\nrounds: 2\n\n請討論登入流程' });
    env.mock.addMessage({ content: '[ASSIGN] @gemini-1\nrole: 後端' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端\ntask: 做登入頁\nbranch: feat/login' });
    env.mock.addMessage({ author: 'human', content: '[GO] 不是主導者' });
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.equal(out.topic.title, '登入功能');
    assert.deepEqual(out.directives.map((m) => m.tag), ['ASSIGN']);
    assert.equal(out.state.phase, 'discussion');
    assert.equal(out.state.role, '前端');
    assert.equal(out.state.round.limit, 2);

    const state = env.readState('claude-1');
    assert.equal(state.topic.title, '登入功能');
    assert.equal(state.task, '做登入頁');
    assert.equal(state.branch, 'feat/login');
    assert.equal(state.isolation, 'worktree');
    assert.equal(state.assigned, true);
    const join = webhookMessages(env.mock).at(-1);
    assert.equal(join.author.username, '前端（claude-1）');
  });

  test('晚進房：議題之後的 [ASSIGN]、[GO]、[STOP] 都依序套用，直接到達正確階段', async () => {
    env.mock.addMessage({ content: '[TOPIC] 登入', attachments: [{ filename: 'spec.md', data: 'x'.repeat(10) }] });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端\n\n細節：做登入頁' });
    env.mock.addMessage({ content: '[GO] @前端' });
    env.mock.addMessage({ content: '[STOP] @gemini-1' });
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    const s = env.readState('claude-1');
    assert.equal(s.phase, 'work');
    assert.equal(s.assignBody, '細節：做登入頁');
    assert.deepEqual(s.topic.attachments, [{ filename: 'spec.md', size: 10 }]);
    assert.match(r.stdout, /之後對你生效的主導者指令：/);
    assert.match(r.stdout, /\[GO\] @前端/);
    assert.ok(!r.stdout.includes('[STOP] @gemini-1'), '沒對到我的指令不印');
    assert.match(r.stdout, /議題附檔：spec\.md（10 B）→ agentchat download --as claude-1 \d+/);
  });

  test('已 leave 後重新進房也檢查頻道衝突（名稱比對不分大小寫）', async () => {
    await env.join('claude-1');
    await env.run(['leave', '--as', 'claude-1']);
    const hook = env.mock.webhooks[0];
    env.mock.addMessage({ author: 'webhook', webhookId: hook.id, username: 'CLAUDE-1', content: '[INFO] 另一台機器的 claude-1' });
    const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /24 小時內有人用過/);
    assert.equal((await env.run(['join', '--as', 'claude-1', '--vendor', 'claude', '--force'])).code, 0);
  });

  test('議題已 [CLOSE]：視為沒有進行中的議題', async () => {
    env.mock.addMessage({ content: '[TOPIC] 議題' });
    env.mock.addMessage({ content: '[ASSIGN] @claude-1\nrole: 前端' });
    env.mock.addMessage({ content: '[CLOSE]' });
    await env.join('claude-1');
    const state = env.readState('claude-1');
    assert.equal(state.phase, 'lobby');
    assert.equal(state.topic, null);
  });

  test('議題只看主導者：其他人發 [TOPIC] 不算', async () => {
    env.mock.addMessage({ author: 'human', content: '[TOPIC] 假議題' });
    await env.join('claude-1');
    assert.equal(env.readState('claude-1').phase, 'lobby');
  });

  test('參數錯誤：名稱不合法、vendor 不對 → 結束碼 2', async () => {
    let r = await env.run(['join', '--as', 'bad name', '--vendor', 'claude']);
    assert.equal(r.code, 2);
    r = await env.run(['join', '--as', 'my-discord-bot', '--vendor', 'claude']);
    assert.equal(r.code, 2);
    r = await env.run(['join', '--as', 'claude-1', '--vendor', 'openai']);
    assert.equal(r.code, 2);
    r = await env.run(['join', '--vendor', 'claude']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /缺少 --as/);
  });
});
