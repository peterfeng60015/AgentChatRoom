// 假 Discord 伺服器：用 node:http 在隨機 port 起，實作 agentchat 用到的 REST 端點。
// 測試以 AGENTCHAT_API_BASE 指過來，絕不連真正的 Discord。這個檔沒有副作用，只匯出函式。
import http from 'node:http';

const EPOCH = 1420070400000n;

const BOT_ROLE_ID = '600000000000000006';
const AVATAR_RE = /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/;

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
    manageMessages: true, // false 時 bot 的角色沒有「管理訊息」，bulk-delete 與 DELETE 訊息回 403
    permissionOverwrites: [], // GET /channels/:id 的 permission_overwrites
    ...options,
  };
  const messages = []; // 由舊到新
  const webhooks = [];
  const files = new Map(); // 附檔路徑 → Buffer
  const requests = []; // 每個請求的紀錄
  const executions = []; // 每次 webhook 發言收到的 payload
  const faults = []; // 模擬錯誤
  const bulkDeletes = []; // 每次 bulk-delete 成功刪掉的 ID
  const deletes = []; // 逐則刪掉的 ID
  const webhookDeletes = []; // DELETE /webhooks/:id 刪掉的 webhook ID
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
    type,
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
      type: type ?? (replyTo ? 19 : 0),
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

  // 放一則指定時間的訊息（測 14 天邊界）：ID 依時間產生，頻道仍維持由舊到新排序。
  function addMessageAt(date, opts = {}) {
    const msg = addMessage(opts);
    msg.id = ((BigInt(new Date(date).getTime()) - EPOCH) << 22n).toString();
    msg.timestamp = new Date(date).toISOString();
    messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return msg;
  }

  // token 做得和真的一樣長（約 68 字），測試「token 不能送進頻道」時才比得到。
  let webhookSeq = 0;
  function addWebhook({ name = 'agentchat', token = `wh-token-${++webhookSeq}-${'k'.repeat(56)}`, channelId = cfg.channelId, avatar = null } = {}) {
    // avatar 存收到的 data URI（真的 Discord 存成雜湊）。
    const hook = { id: nextId(), type: 1, name, token, channel_id: channelId, guild_id: cfg.guildId, avatar };
    webhooks.push(hook);
    return hook;
  }

  // 下一次（或接下來 times 次）符合條件的請求回指定的錯誤；skip 是先放行幾次再開始失敗。
  function fail({ method, path, status, body, times = 1, headers = {}, skip = 0 }) {
    faults.push({ method, path, status, body, times, headers, skip });
  }

  // 下一次（或接下來 times 次）符合條件的請求先等 ms 毫秒再照常處理（模擬網路慢）。
  const delays = [];
  function delay({ method, path, ms, times = 1 }) {
    delays.push({ method, path, ms, times });
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
    if (f.skip > 0) {
      f.skip--;
      return null;
    }
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

    const d = delays.find(
      (x) => x.times > 0 && (!x.method || x.method === req.method) && (!x.path || x.path.test(path)),
    );
    if (d) {
      d.times--;
      await new Promise((r) => setTimeout(r, d.ms));
    }
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
      if (req.method === 'PATCH') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if (body.avatar !== undefined && body.avatar !== null && !AVATAR_RE.test(body.avatar)) {
          return json(res, 400, { message: 'Invalid Form Body', code: 50035, errors: { avatar: { _errors: [{ code: 'IMAGE_INVALID', message: 'Invalid image data' }] } } });
        }
        if (body.avatar !== undefined) hook.avatar = body.avatar;
        if (body.name !== undefined) hook.name = body.name;
        const { token, ...rest } = hook;
        return json(res, 200, rest);
      }
      return json(res, 405, { message: '405: Method Not Allowed', code: 0 });
    }

    if (auth !== `Bot ${cfg.token}`) return json(res, 401, { message: '401: Unauthorized', code: 0 });

    // 刪除 webhook（bot 身分，需要管理 Webhook）。
    const delHook = path.match(/^\/webhooks\/(\d+)$/);
    if (req.method === 'DELETE' && delHook) {
      if (!cfg.webhookPermission) return json(res, 403, { message: 'Missing Permissions', code: 50013 });
      const i = webhooks.findIndex((w) => w.id === delHook[1]);
      if (i < 0) return json(res, 404, { message: 'Unknown Webhook', code: 10015 });
      webhooks.splice(i, 1);
      webhookDeletes.push(delHook[1]);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && path === '/users/@me') {
      return json(res, 200, { id: cfg.botId, username: 'agentchat-bot', discriminator: '0', bot: true });
    }
    const user = path.match(/^\/users\/(\d+)$/);
    if (req.method === 'GET' && user) {
      if (user[1] !== cfg.moderatorId) return json(res, 404, { message: 'Unknown User', code: 10013 });
      return json(res, 200, { id: cfg.moderatorId, username: 'peter', global_name: 'Peter' });
    }
    // bot 的角色：@everyone（ID 同伺服器）只有檢視與讀取歷史；bot 角色依 manageMessages 決定有沒有「管理訊息」。
    const guild = path.match(/^\/guilds\/(\d+)\/(members\/(\d+)|roles)$/);
    if (req.method === 'GET' && guild) {
      if (guild[1] !== cfg.guildId) return json(res, 404, { message: 'Unknown Guild', code: 10004 });
      if (guild[2] === 'roles') {
        return json(res, 200, [
          { id: cfg.guildId, name: '@everyone', permissions: String((1 << 10) | (1 << 16)) },
          { id: BOT_ROLE_ID, name: 'agentchat', permissions: String((1 << 29) | (cfg.manageMessages ? 1 << 13 : 0)) },
        ]);
      }
      if (guild[3] !== cfg.botId) return json(res, 404, { message: 'Unknown Member', code: 10007 });
      return json(res, 200, { user: { id: cfg.botId }, roles: [BOT_ROLE_ID] });
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
          permission_overwrites: cfg.permissionOverwrites,
          last_message_id: messages.length ? messages[messages.length - 1].id : null,
        });
      }
      // hideHistory：模擬 bot 沒有「讀取訊息歷史」權限時 Discord 回空陣列。
      if (req.method === 'GET' && rest === '/messages') {
        return json(res, 200, cfg.hideHistory ? [] : listMessages(url.searchParams));
      }
      const one = rest.match(/^\/messages\/(\d+)$/);
      if (req.method === 'GET' && one) {
        const msg = messages.find((m) => m.id === one[1]);
        return msg ? json(res, 200, msg) : json(res, 404, { message: 'Unknown Message', code: 10008 });
      }
      // 刪除訊息：真的 Discord 的 bulk-delete 只收 2–100 則、都要在 14 天內。
      if (req.method === 'POST' && rest === '/messages/bulk-delete') {
        if (!cfg.manageMessages) return json(res, 403, { message: 'Missing Permissions', code: 50013 });
        const ids = JSON.parse(raw.toString('utf8') || '{}').messages || [];
        if (ids.length < 2 || ids.length > 100) {
          return json(res, 400, { message: 'Invalid Form Body: messages must be between 2 and 100 in length.', code: 50035 });
        }
        const limit = (BigInt(Date.now() - 14 * 24 * 60 * 60 * 1000) - EPOCH) << 22n;
        if (ids.some((id) => BigInt(id) < limit)) {
          return json(res, 400, { message: 'You can only bulk delete messages that are under 14 days old.', code: 50034 });
        }
        for (const id of ids) {
          const i = messages.findIndex((m) => m.id === id);
          if (i >= 0) messages.splice(i, 1);
        }
        bulkDeletes.push([...ids]);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'DELETE' && one) {
        if (!cfg.manageMessages) return json(res, 403, { message: 'Missing Permissions', code: 50013 });
        const i = messages.findIndex((m) => m.id === one[1]);
        if (i < 0) return json(res, 404, { message: 'Unknown Message', code: 10008 });
        messages.splice(i, 1);
        deletes.push(one[1]);
        res.writeHead(204);
        return res.end();
      }
      if (rest === '/webhooks') {
        if (!cfg.webhookPermission) return json(res, 403, { message: 'Missing Permissions', code: 50013 });
        if (req.method === 'GET') return json(res, 200, webhooks.filter((w) => w.channel_id === cfg.channelId));
        if (req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8') || '{}');
          // 真的 Discord：每個頻道最多 15 個 webhook；avatar 必須是 PNG／JPEG／GIF 的 data URI。
          if (webhooks.filter((w) => w.channel_id === cfg.channelId).length >= 15) {
            return json(res, 400, { message: 'Maximum number of webhooks reached (15)', code: 30007 });
          }
          if (body.avatar !== undefined && body.avatar !== null && !AVATAR_RE.test(body.avatar)) {
            return json(res, 400, { message: 'Invalid Form Body', code: 50035 });
          }
          return json(res, 200, addWebhook({ name: body.name, avatar: body.avatar ?? null }));
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
    bulkDeletes,
    deletes,
    webhookDeletes,
    addMessage,
    addMessageAt,
    addWebhook,
    fail,
    delay,
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
