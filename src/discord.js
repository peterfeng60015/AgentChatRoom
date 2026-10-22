import { DiscordError, UserError } from './errors.js';

export const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/peterfeng60015/AgentChatRoom, 0.1.0)';
const DISCORD_EPOCH = 1420070400000n;
const MAX_RETRIES = 5;
// 單次請求的逾時；連線掛住時不要等 undici 預設的幾分鐘。
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// retry_after 太長（全域限流）時與其讓 agent 卡住，不如直接報錯。
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 發言沒有正常回應時，訊息可能已經送出。這裡不知道 agent 名稱與房間，完整的 read 指令由指令層（sendParts）補上。
const UNCERTAIN_HINT = 'Discord 沒有正常回應';
function uncertain(status, why) {
  const e = new DiscordError(status, null, `${UNCERTAIN_HINT}（${why}）`);
  e.uncertain = true;
  return e;
}

// 真正的網路問題（連不上、逾時）才重試；其他例外（例如 token 含換行讓 header 不合法）不重試，
// 而且訊息可能含 token，不能原樣印出。
function isNetworkError(e) {
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' || Boolean(e?.cause);
}

function hintFor(status, label) {
  if (status === 413) return 'Discord 拒收：附檔太大（超過伺服器的上傳上限），請縮小或分開傳';
  if (status === 401 && label.startsWith('/webhooks/')) {
    // 完整的 doctor 指令（含 --room）由指令層補上。
    return 'webhook 已失效（token 不對或已被刪除）';
  }
  if (status === 401) return 'bot token 無效或已重設，請檢查 .env 的 DISCORD_BOT_TOKEN';
  if (status === 403) return `bot 沒有權限存取 ${label}（請確認 bot 已邀進伺服器，且有對應頻道權限）`;
  if (status === 404) return `找不到資源 ${label}（請檢查 room.json 的 ID，或訊息、webhook 是否已被刪除）`;
  if (status === 429) return `Discord 限流，重試 ${MAX_RETRIES} 次仍失敗（${label}）`;
  return null;
}

export function compareSnowflake(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// 把現在時間換成 snowflake，用來當「從現在開始」的游標。
export function snowflakeNow() {
  return ((BigInt(Date.now()) - DISCORD_EPOCH) << 22n).toString();
}

export function snowflakeToDate(id) {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

async function retryAfterMs(res) {
  const data = await res.json().catch(() => ({}));
  const raw = res.headers.get('retry-after');
  const header = raw === null || raw.trim() === '' ? NaN : Number(raw);
  const seconds = Number.isFinite(data?.retry_after) ? data.retry_after : Number.isFinite(header) ? header : 1;
  return Math.max(0, Math.ceil(seconds * 1000));
}

// retryBaseMs：5xx 與網路錯誤的退避基準，第 n 次重試等 retryBaseMs × n。timeoutMs：單次請求的逾時。
export function createClient(token, { apiBase, retryBaseMs = 1000, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = String(apiBase || process.env.AGENTCHAT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  try {
    new URL(base);
  } catch {
    throw new UserError(`AGENTCHAT_API_BASE 不是合法網址：${base}`);
  }

  // label 是給錯誤訊息看的路徑；webhook 路徑含 token，絕不能原樣放進錯誤訊息。
  // retryUncertain 為 false 的請求（發言）不重試 5xx 與網路錯誤：Discord 可能已經收下，重試會重複發言。
  async function request(method, route, { json, form, auth = true, label = route, retryUncertain = true, timeout = timeoutMs } = {}) {
    const headers = { 'User-Agent': USER_AGENT };
    if (auth) headers.Authorization = `Bot ${token}`;
    let body;
    if (form) {
      body = form;
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(base + route, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        if (!isNetworkError(e)) throw new DiscordError(0, null, '無法送出 Discord API 請求（請檢查 bot token 是否含換行或特殊字元）');
        if (!retryUncertain) throw uncertain(0, e.name === 'TimeoutError' ? '逾時' : e.cause?.code || '連線失敗');
        if (attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (attempt + 1));
          continue;
        }
        const why = e.name === 'TimeoutError' ? '逾時' : e.cause?.code || '連線失敗';
        throw new DiscordError(0, null, `無法連線到 Discord API（${new URL(base).host}）：${why}`);
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = await retryAfterMs(res);
        if (wait <= MAX_RATE_LIMIT_WAIT_MS) {
          await sleep(wait + 50);
          continue;
        }
        throw new DiscordError(429, null, `Discord 要求等待 ${Math.ceil(wait / 1000)} 秒（限流），請稍後再試`);
      }
      if (res.status >= 500 && !retryUncertain) {
        await res.arrayBuffer().catch(() => null);
        throw uncertain(res.status, `HTTP ${res.status}`);
      }
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await res.arrayBuffer().catch(() => null);
        await sleep(retryBaseMs * (attempt + 1));
        continue;
      }
      // 回應本體讀到一半斷線或逾時，和連線失敗一樣處理。
      let text;
      try {
        text = await res.text();
      } catch {
        if (!retryUncertain) throw uncertain(0, '讀取回應失敗');
        if (attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (attempt + 1));
          continue;
        }
        throw new DiscordError(0, null, `讀取 Discord API 回應失敗（${new URL(base).host}）`);
      }
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const err = new DiscordError(res.status, data, hintFor(res.status, label));
        if (res.status === 401 && label.startsWith('/webhooks/')) err.needsDoctor = true;
        throw err;
      }
      return data;
    }
  }

  const webhookRoute = (webhook) => `/webhooks/${webhook.id}/${webhook.token}`;
  const webhookLabel = (webhook) => `/webhooks/${webhook.id}/***`;

  async function messages(channelId, { after, before, limit = 100 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set('after', after);
    if (before) q.set('before', before);
    const list = await request('GET', `/channels/${channelId}/messages?${q}`);
    // 一律回傳由舊到新。
    return [...list].sort((a, b) => compareSnowflake(a.id, b.id));
  }

  return {
    apiBase: base,

    me: () => request('GET', '/users/@me'),

    application: () => request('GET', '/applications/@me'),

    user: (userId) => request('GET', `/users/${userId}`),

    channel: (channelId) => request('GET', `/channels/${channelId}`),

    messages,

    // 從 cursor 之後抓到最新，最多 maxPages 頁，由舊到新。
    messagesAfter: async (channelId, cursor, maxPages = 10) => {
      const all = [];
      let after = cursor;
      for (let page = 0; page < maxPages; page++) {
        const batch = await messages(channelId, { after, limit: 100 });
        all.push(...batch);
        if (batch.length < 100) break;
        after = batch[batch.length - 1].id;
      }
      return all;
    },

    message: (channelId, messageId) => request('GET', `/channels/${channelId}/messages/${messageId}`),

    // 刪除訊息（clear 用），都需要「管理訊息」權限。bulkDelete 一次 2–100 則，只能刪 14 天內的。
    bulkDelete: (channelId, messageIds) =>
      request('POST', `/channels/${channelId}/messages/bulk-delete`, { json: { messages: messageIds } }),

    deleteMessage: (channelId, messageId) => request('DELETE', `/channels/${channelId}/messages/${messageId}`),

    // 計算 bot 在頻道的權限用（clear、doctor）。
    guildMember: (guildId, userId) => request('GET', `/guilds/${guildId}/members/${userId}`),

    guildRoles: (guildId) => request('GET', `/guilds/${guildId}/roles`),

    listWebhooks: (channelId) => request('GET', `/channels/${channelId}/webhooks`),

    createWebhook: (channelId, name) => request('POST', `/channels/${channelId}/webhooks`, { json: { name } }),

    // 帶 token 的 webhook 端點不需要 bot 身分，也不送 bot token。
    getWebhook: (id, webhookToken) =>
      request('GET', webhookRoute({ id, token: webhookToken }), { auth: false, label: webhookLabel({ id }) }),

    // 用 webhook 發言，username 可以每則不同，這就是 agent 的顯示名稱；avatarUrl 沒給時用 webhook 本身的頭像。
    executeWebhook: async (webhook, { content, username, avatarUrl, files = [], allowedMentions }) => {
      const payload = {
        content,
        username,
        // 沒指定時什麼都不通知；指令層會放行主導者。
        allowed_mentions: allowedMentions ?? { parse: [] },
      };
      if (avatarUrl) payload.avatar_url = avatarUrl;
      if (files.length) {
        payload.attachments = files.map((f, i) => ({ id: i, filename: f.filename }));
      }
      const route = `${webhookRoute(webhook)}?wait=true`;
      // 有附檔時逾時依大小放寬（每 MB 多 10 秒），慢網路上傳大檔才不會必定逾時。
      const bytes = files.reduce((n, f) => n + (f.data?.length ?? 0), 0);
      const opts = {
        auth: false,
        label: webhookLabel(webhook),
        retryUncertain: false,
        timeout: timeoutMs + Math.ceil(bytes / (1024 * 1024)) * 10_000,
      };
      if (!files.length) return request('POST', route, { ...opts, json: payload });
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      files.forEach((f, i) => {
        form.append(`files[${i}]`, new Blob([f.data], { type: f.contentType || 'application/octet-stream' }), f.filename);
      });
      return request('POST', route, { ...opts, form });
    },

    // 附檔在 CDN 上，不送 bot token。maxBytes 防止下載超大的檔案。
    download: async (url, { maxBytes = Infinity } = {}) => {
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      } catch (e) {
        throw new DiscordError(0, null, `附檔下載失敗：${e.name === 'TimeoutError' ? '逾時' : e.cause?.code || '連線失敗'}`);
      }
      if (!res.ok) {
        throw new DiscordError(res.status, null, '附檔下載失敗，連結可能已過期；請重新執行 download 以取得新連結');
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => null);
        throw new DiscordError(0, null, `附檔超過大小上限（${declared} bytes）`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new DiscordError(0, null, `附檔超過大小上限（${buf.length} bytes）`);
      return buf;
    },
  };
}
