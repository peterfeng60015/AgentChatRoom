// 假 Discord 伺服器：用 node:http 在隨機 port 起，實作 agentchat 用到的 REST 端點。
// 測試以 AGENTCHAT_API_BASE 指過來，絕不連真正的 Discord。這個檔沒有副作用，只匯出函式。
import http from 'node:http';

const EPOCH = 1420070400000n;

export const DEFAULTS = {
  token: 'test-bot-token',
  guildId: '100000000000000001',
  channelId: '200000000000000002',
  moderatorId: '300000000000000003',
  botId: '400000000000000004',
};

function json(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMockDiscord(options = {}) {
  const cfg = {
    ...DEFAULTS,
    appFlags: 1 << 18,
    channelType: 0,
    channelGuildId: null, // 不是 null 時，GET /channels/:id 回這個 guild_id（測試不一致的情況）
    webhookPermission: true, // false 時 webhook 清單與建立回 403
    ...options,
  };
  const messages = []; // 由舊到新
  const webhooks = [];
  const files = new Map(); // 附檔路徑 → Buffer
  const requests = []; // 每個請求的紀錄
  const executions = []; // 每次 webhook 發言收到的 payload
  const faults = []; // 模擬錯誤
  let lastId = 0n;
  let base = '';

  const nextId = () => {
    let id = (BigInt(Date.now()) - EPOCH) << 22n;
    if (id <= lastId) id = lastId + 1n;
    lastId = id;
    return id.toString();
  };

  function storeAttachments(messageId, list = []) {
    return list.map((f) => {
      const id = nextId();
      const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '');
      const key = `/files/${messageId}/${id}/${encodeURIComponent(f.filename)}`;
      files.set(key, data);
      return {
        id,
        filename: f.filename,
        size: f.size ?? data.length,
        url: `${base}${key}`,
        proxy_url: `${base}${key}`,
        content_type: f.content_type ?? f.contentType ?? 'application/octet-stream',
      };
    });
  }

  function mentionsOf(content, allowed) {
    const ids = [...String(content).matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
    if (!allowed) return ids;
    const users = new Set(allowed.users || []);
    const parseUsers = (allowed.parse || []).includes('users');
    return ids.filter((id) => parseUsers || users.has(id));
  }

  // 直接放一則訊息進頻道（主導者、人類、其他 agent）。
  function addMessage({
    author = 'moderator',
    content = '',
    replyTo = null,
    attachments = [],
    timestamp = null,
    webhookId = null,
    username = null,
    referenceType,
  } = {}) {
    const id = nextId();
    let a;
    if (author === 'moderator') a = { id: cfg.moderatorId, username: 'peter', global_name: 'Peter' };
    else if (author === 'human') a = { id: '500000000000000005', username: 'someone', global_name: 'Someone' };
    else if (author === 'webhook') a = { id: webhookId, username, bot: true };
    else a = author;
    const msg = {
      id,
      channel_id: cfg.channelId,
      type: replyTo ? 19 : 0,
      content,
      timestamp: timestamp ?? new Date().toISOString(),
      author: a,
      mentions: mentionsOf(content).map((uid) => ({ id: uid })),
      attachments: storeAttachments(id, attachments),
    };
    if (author === 'webhook') msg.webhook_id = webhookId;
    if (replyTo) {
      msg.message_reference = { message_id: replyTo, channel_id: cfg.channelId };
      if (referenceType !== undefined) msg.message_reference.type = referenceType;
    }
    messages.push(msg);
    return msg;
  }

  function addWebhook({ name = 'agentchat', token = `wh-token-${webhooks.length + 1}`, channelId = cfg.channelId } = {}) {
    const hook = { id: nextId(), type: 1, name, token, channel_id: channelId, guild_id: cfg.guildId };
    webhooks.push(hook);
    return hook;
  }

  // 下一次（或接下來 times 次）符合條件的請求回指定的錯誤。
  function fail({ method, path, status, body, times = 1, headers = {} }) {
    faults.push({ method, path, status, body, times, headers });
  }

  function rateLimit({ method, path, retryAfter = 0.05, times = 1 } = {}) {
    fail({
      method,
      path,
      status: 429,
      times,
      body: { message: 'You are being rate limited.', retry_after: retryAfter, global: false },
    });
  }

  function takeFault(method, path) {
    const f = faults.find(
      (x) => x.times > 0 && (!x.method || x.method === method) && (!x.path || (x.path instanceof RegExp ? x.path.test(path) : x.path === path)),
    );
    if (!f) return null;
    f.times--;
    return f;
  }

  function listMessages(query) {
    const limit = Math.max(1, Math.min(100, Number(query.get('limit') ?? 50)));
    const after = query.get('after');
    const before = query.get('before');
    let list = [...messages];
    if (after) list = list.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
    else if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before)).slice(-limit);
    else list = list.slice(-limit);
    // 真的 Discord 一律新到舊。
    return list.reverse();
  }

  async function executeWebhook(req, res, hook, query, raw) {
    const type = req.headers['content-type'] || '';
    let payload;
    let uploads = [];
    if (type.startsWith('multipart/form-data')) {
      const form = await new Request('http://mock/', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData();
      payload = JSON.parse(form.get('payload_json') || '{}');
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('files[')) continue;
        uploads.push({
          filename: value.name,
          data: Buffer.from(await value.arrayBuffer()),
          content_type: value.type || 'application/octet-stream',
        });
      }
    } else {
      payload = JSON.parse(raw.toString('utf8') || '{}');
    }
    if (!payload.content && !uploads.length) return json(res, 400, { message: 'Cannot send an empty message', code: 50006 });
    if (String(payload.content ?? '').length > 2000) {
      return json(res, 400, { message: 'Invalid Form Body: content must be 2000 or fewer in length.', code: 50035 });
    }
    if (payload.username && String(payload.username).length > 80) {
      return json(res, 400, { message: 'Invalid Form Body: username must be 80 or fewer in length.', code: 50035 });
    }
    // 真的 Discord 不接受含 discord、clyde 的 webhook username。
    if (payload.username && /discord|clyde/i.test(payload.username)) {
      return json(res, 400, { message: 'Invalid Form Body: username cannot contain "discord" or "clyde"', code: 50035 });
    }
    const id = nextId();
    const msg = {
      id,
      channel_id: hook.channel_id,
      type: 0,
      content: payload.content ?? '',
      timestamp: new Date().toISOString(),
      author: { id: hook.id, username: payload.username || hook.name, bot: true },
      webhook_id: hook.id,
      mentions: mentionsOf(payload.content ?? '', payload.allowed_mentions).map((uid) => ({ id: uid })),
      attachments: storeAttachments(id, uploads),
    };
    messages.push(msg);
    executions.push({ id, payload, files: uploads });
    if (query.get('wait') === 'true') return json(res, 200, msg);
    res.writeHead(204);
    return res.end();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const raw = await readBody(req);
    const auth = req.headers.authorization ?? null;
    let path = url.pathname;
    requests.push({ method: req.method, path, query: url.search, auth });

    if (path.startsWith('/files/')) {
      const data = files.get(path);
      if (!data) return json(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
      return res.end(data);
    }
    if (!path.startsWith('/api/v10/')) return json(res, 404, { message: '404: Not Found', code: 0 });
    path = path.slice('/api/v10'.length);

    const fault = takeFault(req.method, path);
    if (fault) return json(res, fault.status, fault.body ?? { message: `mock ${fault.status}` }, fault.headers);

    const wh = path.match(/^\/webhooks\/(\d+)\/([^/]+)$/);
    if (wh) {
      const hook = webhooks.find((w) => w.id === wh[1]);
      if (!hook) return json(res, 404, { message: 'Unknown Webhook', code: 10015 });
      if (hook.token !== decodeURIComponent(wh[2])) return json(res, 401, { message: 'Invalid Webhook Token', code: 50027 });
      if (req.method === 'GET') {
        const { token, ...rest } = hook;
        return json(res, 200, rest);
      }
      if (req.method === 'POST') return executeWebhook(req, res, hook, url.searchParams, raw);
      return json(res, 405, { message: '405: Method Not Allowed', code: 0 });
    }

    if (auth !== `Bot ${cfg.token}`) return json(res, 401, { message: '401: Unauthorized', code: 0 });

    if (req.method === 'GET' && path === '/users/@me') {
      return json(res, 200, { id: cfg.botId, username: 'agentchat-bot', discriminator: '0', bot: true });
    }
    const user = path.match(/^\/users\/(\d+)$/);
    if (req.method === 'GET' && user) {
      if (user[1] !== cfg.moderatorId) return json(res, 404, { message: 'Unknown User', code: 10013 });
      return json(res, 200, { id: cfg.moderatorId, username: 'peter', global_name: 'Peter' });
    }
    if (req.method === 'GET' && path === '/applications/@me') {
      return json(res, 200, { id: cfg.botId, name: 'agentchat', flags: cfg.appFlags });
    }
    const ch = path.match(/^\/channels\/(\d+)(\/.*)?$/);
    if (ch) {
      if (ch[1] !== cfg.channelId) return json(res, 404, { message: 'Unknown Channel', code: 10003 });
      const rest = ch[2] ?? '';
      if (req.method === 'GET' && rest === '') {
        return json(res, 200, {
          id: cfg.channelId,
          type: cfg.channelType,
          guild_id: cfg.channelGuildId ?? cfg.guildId,
          name: 'agent-room',
        });
      }
      if (req.method === 'GET' && rest === '/messages') return json(res, 200, listMessages(url.searchParams));
      const one = rest.match(/^\/messages\/(\d+)$/);
      if (req.method === 'GET' && one) {
        const msg = messages.find((m) => m.id === one[1]);
        return msg ? json(res, 200, msg) : json(res, 404, { message: 'Unknown Message', code: 10008 });
      }
      if (rest === '/webhooks') {
        if (!cfg.webhookPermission) return json(res, 403, { message: 'Missing Permissions', code: 50013 });
        if (req.method === 'GET') return json(res, 200, webhooks.filter((w) => w.channel_id === cfg.channelId));
        if (req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8') || '{}');
          return json(res, 200, addWebhook({ name: body.name }));
        }
      }
    }
    return json(res, 404, { message: '404: Not Found', code: 0 });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => json(res, 500, { message: `mock error: ${e.message}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    config: cfg,
    apiBase: `${base}/api/v10`,
    origin: base,
    messages,
    webhooks,
    requests,
    executions,
    addMessage,
    addWebhook,
    fail,
    rateLimit,
    nextId,
    lastMessage: () => messages[messages.length - 1],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
