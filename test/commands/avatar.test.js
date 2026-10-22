// webhook 發言的頭像（SPEC §3.1 avatarUrlTemplate、avatarStyles，§6.2 頭像）。不連 DiceBear，只看送給假 Discord 的 avatar_url。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';
import { avatarUrl } from '../../src/publish.js';

const DICEBEAR = 'https://api.dicebear.com/10.x';
const avatars = (env, skip = 0) => env.mock.executions.slice(skip).map((e) => e.payload.avatar_url);

describe('頭像：預設 DiceBear', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  test('每則 agent 發言都帶 avatar_url；同名同圖，vendor 決定風格', async () => {
    env = await setup();
    const vendors = { 'claude-1': 'claude', 'gemini-1': 'gemini', 'codex-1': 'codex', 'other-1': 'other' };
    for (const [name, vendor] of Object.entries(vendors)) {
      const r = await env.run(['join', '--as', name, '--vendor', vendor]);
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(avatars(env), [
      `${DICEBEAR}/bottts/png?seed=claude-1&size=128`,
      `${DICEBEAR}/pixel-art/png?seed=gemini-1&size=128`,
      `${DICEBEAR}/adventurer/png?seed=codex-1&size=128`,
      `${DICEBEAR}/identicon/png?seed=other-1&size=128`,
    ]);

    // 同一個 agent 之後的發言（含切段的每一則、換了角色）頭像都一樣。
    const skip = env.mock.executions.length;
    env.patchState('claude-1', { role: '前端' });
    const r = await env.run(['post', '--as', 'claude-1', '長'.repeat(2500)]);
    assert.equal(r.code, 0, r.stderr);
    const sent = avatars(env, skip);
    assert.ok(sent.length >= 2, '切成多則');
    for (const url of sent) assert.equal(url, `${DICEBEAR}/bottts/png?seed=claude-1&size=128`);

    // 帶附檔時走 multipart，avatar_url 在 payload_json 裡。
    const file = path.join(env.root, 'a.txt');
    fs.writeFileSync(file, 'x');
    const f = await env.run(['post', '--as', 'claude-1', '--file', file, '有附檔']);
    assert.equal(f.code, 0, f.stderr);
    assert.equal(env.mock.executions.at(-1).files.length, 1);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, `${DICEBEAR}/bottts/png?seed=claude-1&size=128`);
  });

  test('名稱不分大小寫：Claude-1 與 claude-1 同圖（seed 用小寫）', async () => {
    env = await setup();
    await env.join('Claude-1');
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, `${DICEBEAR}/bottts/png?seed=claude-1&size=128`);
    const r = await env.run(['post', '--as', 'CLAUDE-1', 'hi']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(env.mock.executions.at(-1).payload.avatar_url, `${DICEBEAR}/bottts/png?seed=claude-1&size=128`);
    assert.equal(avatarUrl({ avatarUrlTemplate: '{name}', avatarStyles: {} }, { name: 'AbC-1' }), 'abc-1');
  });

  test('自動 [IDLE] 帶頭像；doctor --send-test 不帶；狀態檔沒有 vendor 時用 other 的風格', async () => {
    env = await setup();
    await env.join('claude-1');
    env.patchState('claude-1', { vendor: null, emptyWaitSince: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const skip = env.mock.executions.length;
    const r = await env.run(['wait', '--as', 'claude-1', '--timeout', '1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(env.mock.executions.at(-1).payload.content, /^\[IDLE\] claude-1/);
    assert.deepEqual(avatars(env, skip), [`${DICEBEAR}/identicon/png?seed=claude-1&size=128`]);

    const d = await env.run(['doctor', '--send-test']);
    assert.equal(d.code, 0, d.stdout);
    assert.equal(env.mock.executions.at(-1).payload.content, '[INFO] doctor 測試');
    assert.ok(!('avatar_url' in env.mock.executions.at(-1).payload), 'doctor 測試訊息不帶頭像');
  });
});

describe('頭像：room.json 設定', () => {
  let env;
  afterEach(async () => {
    await env?.close();
  });

  for (const off of [null, '']) {
    test(`avatarUrlTemplate 是 ${JSON.stringify(off)}：不帶 avatar_url`, async () => {
      env = await setup({ room: { avatarUrlTemplate: off } });
      await env.join('claude-1');
      const r = await env.run(['post', '--as', 'claude-1', '沒有頭像']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(env.mock.executions.length, 2);
      for (const e of env.mock.executions) assert.ok(!('avatar_url' in e.payload), JSON.stringify(e.payload));
    });
  }

  test('avatarStyles 是 null：用預設風格', async () => {
    env = await setup({ room: { avatarStyles: null } });
    await env.join('claude-1');
    assert.deepEqual(avatars(env), [`${DICEBEAR}/bottts/png?seed=claude-1&size=128`]);
  });

  test('自訂網址與部分覆蓋 avatarStyles：沒寫的 vendor 沿用預設', async () => {
    env = await setup({
      room: { avatarUrlTemplate: 'HTTPS://img.example/{vendor}/{style}/{name}.png', avatarStyles: { claude: 'my style' } },
    });
    await env.join('claude-1');
    assert.equal((await env.run(['join', '--as', 'gemini-1', '--vendor', 'gemini'])).code, 0);
    assert.deepEqual(avatars(env), ['HTTPS://img.example/claude/my%20style/claude-1.png', 'HTTPS://img.example/gemini/pixel-art/gemini-1.png']);
  });

  test('不合法的設定：結束碼 2，不發言', async () => {
    for (const [room, field] of [
      [{ avatarUrlTemplate: 'ftp://x/{name}' }, /avatarUrlTemplate 必須是/],
      [{ avatarUrlTemplate: 'https://' }, /avatarUrlTemplate 必須是/],
      [{ avatarUrlTemplate: 42 }, /avatarUrlTemplate 必須是/],
      [{ avatarStyles: ['bottts'] }, /avatarStyles 必須是 JSON 物件/],
      [{ avatarStyles: 'bottts' }, /avatarStyles 必須是 JSON 物件/],
      [{ avatarStyles: { claude: '' } }, /avatarStyles\.claude 必須是/],
      [{ avatarStyles: { gemini: null } }, /avatarStyles\.gemini 必須是/],
      [{ avatarStyles: { claude: 3 } }, /avatarStyles\.claude 必須是/],
    ]) {
      env = await setup({ room });
      const r = await env.run(['join', '--as', 'claude-1', '--vendor', 'claude']);
      assert.equal(r.code, 2, JSON.stringify(room));
      assert.match(r.stderr, field);
      assert.equal(env.mock.executions.length, 0);
      await env.close();
      env = null;
    }
  });
});

test('avatarUrl：名稱、vendor、風格都 URL 編碼；不認得的 vendor 用 other 的風格', () => {
  const room = {
    avatarUrlTemplate: 'https://x/{style}/png?seed={name}&v={vendor}&{unknown}',
    avatarStyles: { claude: 'bottts', other: 'identicon' },
  };
  assert.equal(avatarUrl(room, { name: 'a b&c/?#中', vendor: 'claude' }), 'https://x/bottts/png?seed=a%20b%26c%2F%3F%23%E4%B8%AD&v=claude&{unknown}');
  assert.equal(avatarUrl(room, { name: 'x', vendor: 'llama' }), 'https://x/identicon/png?seed=x&v=llama&{unknown}');
  assert.equal(avatarUrl(room, { name: 'x', vendor: 'toString' }), 'https://x/identicon/png?seed=x&v=toString&{unknown}');
  assert.equal(avatarUrl(room, { name: 'x', vendor: null }), 'https://x/identicon/png?seed=x&v=other&{unknown}');
  assert.equal(avatarUrl({ ...room, avatarUrlTemplate: null }, { name: 'x', vendor: 'claude' }), null);
});
