// src/discord.js 的單元測試（SPEC §7.4、§9）。
// 用 node:http 在 127.0.0.1 的隨機 port 起假伺服器，以 AGENTCHAT_API_BASE 指過去，不連外部網路。
// 重試的等待用 retryBaseMs 調小，避免測試變慢。
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

// 每個測試換一個 handler；伺服器記下收到的每個請求。
let handler = (rec, res) => sendJson(res, 404, { message: 'no handler' });
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://127.0.0.1');
  const rec = {
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: Buffer.concat(chunks),
    at: Date.now(),
    req,
  };
  requests.push(rec);
  try {
    await handler(rec, res);
  } catch (e) {
    sendJson(res, 599, { message: String(e) });
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const API = `${ORIGIN}/api/v10`;

const savedApiBase = process.env.AGENTCHAT_API_BASE;
process.env.AGENTCHAT_API_BASE = API;

const discord = await import(pathToFileURL(path.join(SRC_DIR, 'discord.js')).href);
const { DiscordError } = await import(pathToFileURL(path.join(SRC_DIR, 'errors.js')).href);
const { createClient, compareSnowflake, snowflakeNow, snowflakeToDate } = discord;

after(() => {
  if (savedApiBase === undefined) delete process.env.AGENTCHAT_API_BASE;
  else process.env.AGENTCHAT_API_BASE = savedApiBase;
  server.closeAllConnections?.();
  server.close();
});

const BOT_TOKEN = 'BOT.TOKEN-should-never-leak';
const HOOK = { id: '7000000000000000001', token: 'webhook-token-should-never-leak' };

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}
function serve(fn) {
  requests.length = 0;
  handler = fn;
}
// 去掉 API 前綴後的路徑。
const routeOf = (rec) => rec.path.replace(/^\/api\/v10/, '');
// 除了驗環境變數預設值的那一題，都明確傳 apiBase：實作就算沒讀 AGENTCHAT_API_BASE，也不會打到真的 discord.com。
const client = (opts = {}) => createClient(BOT_TOKEN, { apiBase: API, retryBaseMs: 1, ...opts });
const isDiscordError = (status) => (e) => {
  assert.ok(e instanceof DiscordError, `應該是 DiscordError：${e}`);
  if (status !== undefined) assert.equal(e.status, status);
  return true;
};
const errorOf = (promise) => promise.then(() => assert.fail('應該要丟錯'), (e) => e);

// ---- snowflake ----

describe('snowflake 函式', () => {
  test('compareSnowflake 依數值比較（不是字串）', () => {
    assert.equal(Math.sign(compareSnowflake('1', '2')), -1);
    assert.equal(Math.sign(compareSnowflake('2', '1')), 1);
    assert.equal(compareSnowflake('5', '5'), 0);
    assert.equal(Math.sign(compareSnowflake('9', '10')), -1);
    // 超過 Number 精度的 ID 也要比得出來。
    assert.equal(Math.sign(compareSnowflake('1300000000000000001', '1300000000000000002')), -1);
  });

  test('snowflakeToDate：Discord 文件的範例 ID', () => {
    const d = snowflakeToDate('175928847299117063');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2016-04-30T11:18:25.796Z');
  });

  test('snowflakeNow：換回時間接近現在，且比既有的 ID 大', () => {
    const id = snowflakeNow();
    assert.match(id, /^\d+$/);
    assert.ok(Math.abs(snowflakeToDate(id).getTime() - Date.now()) < 2000);
    assert.equal(Math.sign(compareSnowflake(id, '175928847299117063')), 1);
  });
});

// ---- 位址與路由 ----

describe('createClient：位址與路由', () => {
  test('沒給 apiBase 時用 AGENTCHAT_API_BASE；帶 Bot token', async () => {
    serve((rec, res) => sendJson(res, 200, { id: '1', username: 'agentchat-bot' }));
    const me = await createClient(BOT_TOKEN, { retryBaseMs: 1 }).me();
    assert.deepEqual(me, { id: '1', username: 'agentchat-bot' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].path, '/api/v10/users/@me');
    assert.equal(requests[0].headers.authorization, `Bot ${BOT_TOKEN}`);
  });

  test('明確給的 apiBase 優先於環境變數', async () => {
    serve((rec, res) => sendJson(res, 200, { ok: 1 }));
    await client({ apiBase: `${ORIGIN}/other-base` }).me();
    assert.equal(requests[0].path, '/other-base/users/@me');
  });

  test('各端點的方法與路徑', async () => {
    serve((rec, res) => sendJson(res, 200, { echo: routeOf(rec) }));
    const c = client();
    const cases = [
      [() => c.application(), 'GET', '/applications/@me'],
      [() => c.channel('123'), 'GET', '/channels/123'],
      [() => c.message('123', '456'), 'GET', '/channels/123/messages/456'],
      [() => c.listWebhooks('123'), 'GET', '/channels/123/webhooks'],
      [() => c.createWebhook('123', 'agentchat'), 'POST', '/channels/123/webhooks'],
      [() => c.getWebhook(HOOK.id, HOOK.token), 'GET', `/webhooks/${HOOK.id}/${HOOK.token}`],
    ];
    for (const [call, method, route] of cases) {
      requests.length = 0;
      const out = await call();
      assert.equal(requests.length, 1, route);
      assert.equal(requests[0].method, method, route);
      assert.equal(routeOf(requests[0]), route);
      assert.deepEqual(out, { echo: route });
    }
  });

  test('createWebhook 送出 { name }', async () => {
    serve((rec, res) => sendJson(res, 200, { id: '9', token: 't', name: 'agentchat' }));
    await client().createWebhook('123', 'agentchat');
    assert.deepEqual(JSON.parse(requests[0].body.toString()), { name: 'agentchat' });
  });
});

// ---- 讀訊息 ----

describe('messages / messagesAfter', () => {
  test('messages 傳 after、before、limit，回傳由舊到新（依數值排序）', async () => {
    serve((rec, res) => sendJson(res, 200, [{ id: '100' }, { id: '10' }, { id: '9' }]));
    const c = client();
    const list = await c.messages('123', { after: '5', limit: 50 });
    assert.deepEqual(list.map((m) => m.id), ['9', '10', '100']);
    assert.equal(routeOf(requests[0]), '/channels/123/messages');
    assert.equal(requests[0].query.after, '5');
    assert.equal(requests[0].query.limit, '50');

    requests.length = 0;
    await c.messages('123', { before: '77', limit: 20 });
    assert.equal(requests[0].query.before, '77');
    assert.equal(requests[0].query.limit, '20');
  });

  // 假頻道：游標之後有 250 則。Discord 對 after 回傳游標後最近的一批，順序由新到舊。
  const channel = Array.from({ length: 250 }, (_, i) => String(1001n + BigInt(i)));
  const pager = (rec, res) => {
    const after = BigInt(rec.query.after);
    const limit = Number(rec.query.limit || 50);
    const page = channel.filter((id) => BigInt(id) > after).slice(0, limit).reverse();
    sendJson(res, 200, page.map((id) => ({ id })));
  };

  // SPEC 沒規定每頁幾則，從實作送出的 limit 算預期值。
  test('messagesAfter 一頁一頁抓到最新，由舊到新、不重複', async () => {
    serve(pager);
    const all = await client().messagesAfter('123', '1000');
    assert.deepEqual(all.map((m) => m.id), channel);
    const per = Number(requests[0].query.limit);
    assert.ok(per > 0 && per <= 100, `每頁 ${per} 則`);
    assert.ok(requests.length >= Math.ceil(channel.length / per) && requests.length <= Math.ceil(channel.length / per) + 1);
  });

  test('messagesAfter 最多抓 maxPages 頁', async () => {
    serve(pager);
    const all = await client().messagesAfter('123', '1000', 2);
    const per = Number(requests[0].query.limit);
    assert.equal(requests.length, 2);
    assert.deepEqual(all.map((m) => m.id), channel.slice(0, 2 * per));
  });
});

// ---- webhook 發言與下載 ----

describe('executeWebhook / download', () => {
  // 真正的 Discord 只有 wait=true 才回傳訊息物件，否則 204。
  const hookServer = (rec, res) => {
    if (rec.query.wait === 'true') sendJson(res, 200, { id: '555' });
    else sendJson(res, 204);
  };

  test('送出 content、username、allowed_mentions，回傳送出的訊息', async () => {
    serve(hookServer);
    const allowedMentions = { parse: [], users: ['816128017460887562'] };
    const msg = await client().executeWebhook(HOOK, { content: '[INFO] hi', username: 'claude-1 (前端)', allowedMentions });
    assert.equal(msg.id, '555');
    assert.equal(requests[0].method, 'POST');
    assert.equal(routeOf(requests[0]), `/webhooks/${HOOK.id}/${HOOK.token}`);
    const payload = JSON.parse(requests[0].body.toString());
    assert.equal(payload.content, '[INFO] hi');
    assert.equal(payload.username, 'claude-1 (前端)');
    assert.deepEqual(payload.allowed_mentions, allowedMentions);
  });

  test('帶附檔時用 multipart，含 payload_json 與檔案內容', async () => {
    serve(hookServer);
    const msg = await client().executeWebhook(HOOK, {
      content: '[INFO] 附檔',
      username: 'claude-1',
      files: [{ filename: 'note.txt', data: Buffer.from('hello file'), contentType: 'text/plain' }],
      allowedMentions: { parse: [] },
    });
    assert.equal(msg.id, '555');
    assert.match(requests[0].headers['content-type'], /^multipart\/form-data/);
    const body = requests[0].body.toString();
    assert.ok(body.includes('name="payload_json"'));
    assert.ok(body.includes('filename="note.txt"'));
    assert.ok(body.includes('hello file'));
    assert.ok(body.includes('[INFO] 附檔'));
  });

  // §7.4 例外：發言只在 429 重試；5xx 與網路錯誤可能已經送出，重送會重複發言。
  for (const [label, fail] of [
    ['5xx', (rec, res) => sendJson(res, 502, { message: 'bad gateway' })],
    ['網路錯誤', (rec) => rec.req.socket.destroy()],
  ]) {
    test(`executeWebhook 遇到${label}：不重試，提示先用 read --last 5 確認`, async () => {
      serve(fail);
      const err = await errorOf(client().executeWebhook(HOOK, { content: '[INFO] hi', username: 'claude-1', allowedMentions: { parse: [] } }));
      isDiscordError()(err);
      assert.equal(requests.length, 1);
      assert.ok(err.message.includes('agentchat read --last 5'), err.message);
    });
  }

  test('executeWebhook 遇到 429：依 retry_after 重試', async () => {
    let n = 0;
    serve((rec, res) => {
      n += 1;
      if (n === 1) sendJson(res, 429, { message: 'rate limited', retry_after: 0.01 });
      else hookServer(rec, res);
    });
    const msg = await client().executeWebhook(HOOK, { content: '[INFO] hi', username: 'claude-1', allowedMentions: { parse: [] } });
    assert.equal(msg.id, '555');
    assert.equal(requests.length, 2);
  });

  test('executeWebhook 帶附檔遇到 429：重送時仍帶著檔案內容', async () => {
    let n = 0;
    serve((rec, res) => {
      n += 1;
      if (n === 1) sendJson(res, 429, { message: 'rate limited', retry_after: 0.01 });
      else hookServer(rec, res);
    });
    const files = [{ filename: 'note.txt', data: Buffer.from('hello again'), contentType: 'text/plain' }];
    const msg = await client().executeWebhook(HOOK, { content: '[INFO] 附檔', username: 'claude-1', files, allowedMentions: { parse: [] } });
    assert.equal(msg.id, '555');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].body.toString().includes('hello again'));
  });

  test('executeWebhook 已回 200 但內文讀到一半斷線：不重試，提示先用 read --last 5 確認', async () => {
    serve((rec, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"id":"55');
      setTimeout(() => rec.req.socket.destroy(), 20);
    });
    const err = await errorOf(client().executeWebhook(HOOK, { content: '[INFO] hi', username: 'claude-1', allowedMentions: { parse: [] } }));
    isDiscordError()(err);
    assert.equal(requests.length, 1);
    assert.ok(err.message.includes('agentchat read --last 5'), err.message);
  });

  test('download 回傳檔案內容的 Buffer', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    serve((rec, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    });
    const buf = await client().download(`${ORIGIN}/cdn/attachments/1/2/a.bin`);
    assert.deepEqual([...Buffer.from(buf)], [...bytes]);
  });

  test('download 失敗丟 DiscordError', async () => {
    serve((rec, res) => sendJson(res, 404, { message: 'gone' }));
    await assert.rejects(client().download(`${ORIGIN}/cdn/x`), isDiscordError());
  });
});

// ---- 錯誤提示 ----

describe('401、403、404：專屬的中文提示、不重試、不洩漏 token', () => {
  // 一般錯誤訊息本身可能就含中文，所以拿沒有專屬提示的 418 當對照：401/403/404 不能只是把狀態碼換掉。
  const messageFor = async (status) => {
    serve((rec, res) => sendJson(res, status, { message: 'nope', code: 0 }));
    return errorOf(client().channel('123'));
  };

  for (const status of [401, 403, 404]) {
    test(`${status}`, async () => {
      const generic = (await messageFor(418)).message.replaceAll('418', String(status));
      const err = await messageFor(status);
      isDiscordError(status)(err);
      assert.notEqual(err.message, generic, `沒有專屬提示：${err.message}`);
      assert.match(err.message, /[\u4e00-\u9fff]/);
      assert.ok(!err.message.includes(BOT_TOKEN));
      assert.equal(requests.length, 1);
    });
  }
});

describe('webhook 端點出錯時，錯誤訊息與 stack 都不含 webhook token（§9）', { timeout: 20000 }, () => {
  const calls = [
    ['getWebhook', () => client().getWebhook(HOOK.id, HOOK.token)],
    ['executeWebhook', () => client().executeWebhook(HOOK, { content: 'x', username: 'claude-1', allowedMentions: { parse: [] } })],
  ];
  const failures = [
    ['404', (rec, res) => sendJson(res, 404, { message: 'Unknown Webhook', code: 10015 })],
    ['5xx', (rec, res) => sendJson(res, 502, { message: 'bad gateway' })],
    ['429 超過 60 秒', (rec, res) => sendJson(res, 429, { message: 'rate limited', retry_after: 61 })],
    ['連線被切斷', (rec) => rec.req.socket.destroy()],
  ];
  for (const [label, fail] of failures) {
    for (const [name, call] of calls) {
      test(`${name}：${label}`, async () => {
        serve(fail);
        const err = await errorOf(call());
        isDiscordError()(err);
        assert.ok(!err.message.includes(HOOK.token), err.message);
        assert.ok(!String(err.stack).includes(HOOK.token));
        assert.ok(!err.message.includes(BOT_TOKEN));
      });
    }
  }
});

// ---- 重試 ----

// 加逾時：實作若沒照 retryBaseMs 或 60 秒上限，測試會變慢而不是卡住。
describe('重試（429、5xx、網路錯誤）', { timeout: 20000 }, () => {
  test('429 依 retry_after 等待後重試，成功就回傳', async () => {
    let n = 0;
    serve((rec, res) => {
      n += 1;
      if (n === 1) sendJson(res, 429, { message: 'You are being rate limited.', retry_after: 0.2, global: false });
      else sendJson(res, 200, { ok: true });
    });
    const t0 = Date.now();
    assert.deepEqual(await client().me(), { ok: true });
    assert.equal(requests.length, 2);
    assert.ok(Date.now() - t0 >= 180, `只等了 ${Date.now() - t0} ms`);
  });

  test('429 一直發生：重試 5 次（共 6 次請求）後丟 DiscordError', async () => {
    serve((rec, res) => sendJson(res, 429, { message: 'rate limited', retry_after: 0.001 }));
    await assert.rejects(client().me(), isDiscordError(429));
    assert.equal(requests.length, 6);
  });

  test('429 的 retry_after 超過 60 秒：不等，直接丟 DiscordError，訊息寫明要等幾秒', async () => {
    serve((rec, res) => sendJson(res, 429, { message: 'rate limited', retry_after: 61 }));
    const t0 = Date.now();
    const err = await client().me().catch((e) => e);
    isDiscordError()(err);
    assert.ok(err.message.includes('61'), err.message);
    assert.equal(requests.length, 1);
    assert.ok(Date.now() - t0 < 5000);
  });

  test('5xx 退避重試，之後成功就回傳', async () => {
    let n = 0;
    serve((rec, res) => {
      n += 1;
      if (n <= 2) sendJson(res, n === 1 ? 500 : 503, { message: 'server error' });
      else sendJson(res, 200, { ok: true });
    });
    assert.deepEqual(await client().channel('1'), { ok: true });
    assert.equal(requests.length, 3);
  });

  test('5xx 一直發生：重試 5 次（共 6 次請求）後丟 DiscordError；retryBaseMs 小時很快結束', async () => {
    serve((rec, res) => sendJson(res, 502, { message: 'bad gateway' }));
    const t0 = Date.now();
    await assert.rejects(client().channel('1'), isDiscordError(502));
    assert.equal(requests.length, 6);
    assert.ok(Date.now() - t0 < 1000, `retryBaseMs 1 卻花了 ${Date.now() - t0} ms`);
  });

  test('退避時間是線性的：第 n 次重試等 retryBaseMs × n', async () => {
    serve((rec, res) => sendJson(res, 500, { message: 'server error' }));
    await assert.rejects(client({ retryBaseMs: 100 }).me(), isDiscordError(500));
    assert.equal(requests.length, 6);
    const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
    gaps.forEach((gap, i) => assert.ok(gap >= 100 * (i + 1) - 5, `第 ${i + 1} 次重試只等了 ${gap} ms：${gaps}`));
    // 線性時第 5 次約 500 ms；指數退避會到 1600 ms。
    assert.ok(gaps[4] < 900, `第 5 次重試等了 ${gaps[4]} ms，不像線性：${gaps}`);
  });

  test('retryBaseMs 預設 1000', async () => {
    let n = 0;
    serve((rec, res) => {
      n += 1;
      if (n === 1) sendJson(res, 500, { message: 'server error' });
      else sendJson(res, 200, { ok: true });
    });
    const t0 = Date.now();
    await createClient(BOT_TOKEN, { apiBase: API }).me();
    assert.ok(Date.now() - t0 >= 950, `只等了 ${Date.now() - t0} ms`);
  });

  test('網路錯誤（連線被切斷）：重試 5 次（共 6 次請求）後丟 DiscordError；也照 retryBaseMs 退避', async () => {
    serve((rec) => rec.req.socket.destroy());
    const t0 = Date.now();
    await assert.rejects(client().me(), isDiscordError());
    assert.equal(requests.length, 6);
    assert.ok(Date.now() - t0 < 1000, `retryBaseMs 1 卻花了 ${Date.now() - t0} ms`);
  });

  test('網路錯誤之後恢復：回傳結果', async () => {
    let n = 0;
    serve((rec, res) => {
      n += 1;
      if (n === 1) rec.req.socket.destroy();
      else sendJson(res, 200, { ok: true });
    });
    assert.deepEqual(await client().me(), { ok: true });
    assert.equal(requests.length, 2);
  });
});
