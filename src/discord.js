import { DiscordError } from './errors.js';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (agentchat, 0.1.0)';
const DISCORD_EPOCH = 1420070400000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hintFor(status, route) {
  if (status === 401) return 'bot token 無效或已重設，請檢查 .env 的 DISCORD_BOT_TOKEN';
  if (status === 403) return `bot 沒有權限存取 ${route}（請確認 bot 已邀進伺服器，且有對應頻道權限）`;
  if (status === 404) return `找不到資源 ${route}（請檢查 room.json 的 ID 或訊息是否已被刪除）`;
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

export function createClient(token) {
  async function request(method, route, { json, form, retries = 5 } = {}) {
    const headers = { 'User-Agent': USER_AGENT, Authorization: `Bot ${token}` };
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
        res = await fetch(API + route, { method, headers, body });
      } catch (e) {
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new DiscordError(0, null, `無法連線到 discord.com：${e.message}`);
      }
      if (res.status === 429 && attempt < retries) {
        const data = await res.json().catch(() => ({}));
        await sleep(Math.ceil((data.retry_after ?? 1) * 1000) + 100);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) throw new DiscordError(res.status, data, hintFor(res.status, route));
      return data;
    }
  }

  return {
    me: () => request('GET', '/users/@me'),

    channel: (channelId) => request('GET', `/channels/${channelId}`),

    // 一律回傳由舊到新。
    messages: async (channelId, { after, before, limit = 100 } = {}) => {
      const q = new URLSearchParams({ limit: String(limit) });
      if (after) q.set('after', after);
      if (before) q.set('before', before);
      const list = await request('GET', `/channels/${channelId}/messages?${q}`);
      return list.sort((a, b) => compareSnowflake(a.id, b.id));
    },

    // 從 cursor 之後抓到最新，最多 maxPages 頁。
    messagesAfter: async function (channelId, cursor, maxPages = 10) {
      const all = [];
      let after = cursor;
      for (let page = 0; page < maxPages; page++) {
        const batch = await this.messages(channelId, { after, limit: 100 });
        all.push(...batch);
        if (batch.length < 100) break;
        after = batch[batch.length - 1].id;
      }
      return all;
    },

    message: (channelId, messageId) => request('GET', `/channels/${channelId}/messages/${messageId}`),

    listWebhooks: (channelId) => request('GET', `/channels/${channelId}/webhooks`),

    createWebhook: (channelId, name) => request('POST', `/channels/${channelId}/webhooks`, { json: { name } }),

    // 用 webhook 發言，username 可以每則不同，這就是 agent 的顯示名稱。
    executeWebhook: async (webhook, { content, username, files = [], allowedMentions }) => {
      const payload = {
        content,
        username,
        allowed_mentions: allowedMentions ?? { parse: ['users'] },
      };
      const route = `/webhooks/${webhook.id}/${webhook.token}?wait=true`;
      if (!files.length) return request('POST', route, { json: payload });
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      files.forEach((f, i) => {
        form.append(`files[${i}]`, new Blob([f.data], { type: f.contentType || 'application/octet-stream' }), f.filename);
      });
      return request('POST', route, { form });
    },

    download: async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        throw new DiscordError(res.status, null, '附檔下載失敗，連結可能已過期；請重新執行 download 以取得新連結');
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
