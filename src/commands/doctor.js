import fs from 'node:fs';
import { ENV_FILE, findToken, loadRoom } from '../config.js';
import { DEFAULT_API_BASE, createClient } from '../discord.js';
import { DiscordError } from '../errors.js';
import { validateAgentName } from '../protocol.js';

// doctor 不需要 --as；非預設房間帶 --room。
const readText = (room) => `agentchat read${room?.roomArg ? ` --room ${room.roomArg}` : ''} --last 5`;
import { loadAgent } from '../state.js';
import { WEBHOOK_SOURCE_TEXT, ensureWebhook, summaryLine } from '../context.js';

export const summary = '逐項檢查 Node、設定、bot token、Discord 權限與 webhook';
export const usage = 'agentchat doctor [--as <名稱>] [--send-test]';
export const options = { 'send-test': { type: 'boolean', default: false } };
export const details = [
  '每項一行 [OK]、[WARN] 或 [FAIL]，最後一行總結。有 FAIL 時結束碼 1，設定問題結束碼 2。',
  '--send-test：用 webhook 發一則 [INFO] doctor 測試（只有帶這個選項才發）。',
  '--as：額外印出該 agent 的本機狀態摘要。',
];

const MESSAGE_CONTENT = (1 << 18) | (1 << 19);
const THREAD_TYPES = new Set([10, 11, 12]);
const TEXT_TYPES = new Set([0, 5]);

function nodeOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 18 || (major === 18 && minor >= 17);
}

export async function run(ctx) {
  const checks = [];
  let configFail = false;
  const add = (level, item, message) => checks.push({ level, item, message });
  const fail = (item, message, config = false) => {
    add('FAIL', item, message);
    if (config) configFail = true;
  };

  // 1. Node 版本
  if (nodeOk()) add('OK', 'Node', `v${process.versions.node}`);
  else fail('Node', `v${process.versions.node} 太舊，需要 18.17 以上`);

  // 2. room.json
  let room = null;
  try {
    room = loadRoom(ctx.values.room);
    add('OK', '房間設定', `${room.roomName}（頻道 ${room.channelId}，${room.file}）`);
  } catch (e) {
    fail('房間設定', e.message, true);
  }

  // 3. bot token（不印出 token）
  let token = null;
  try {
    const found = findToken();
    token = found.token;
    if (token) add('OK', 'bot token', `已找到（來源：${found.source}）`);
    else fail('bot token', '找不到 DISCORD_BOT_TOKEN：請設定環境變數，或複製 .env.example 為 .env 並填入', true);
  } catch (e) {
    fail('bot token', e.message, true);
  }

  let webhook = null;
  let skipped = false;
  if (room && token) {
    // AGENTCHAT_API_BASE 不是合法網址時 createClient 會丟錯：記成 FAIL，略過 Discord 檢查，其餘項目照做。
    let client = null;
    try {
      client = createClient(token);
    } catch (e) {
      fail('API 位址', e.message, true);
    }
    const step = async (item, fn) => {
      try {
        await fn();
        return true;
      } catch (e) {
        fail(item, e instanceof DiscordError ? e.message : `${e.message}`);
        return false;
      }
    };

    if (!client) skipped = true;
    // 4. token 有效
    const meOk = client && (await step('bot 身分', async () => {
      const me = await client.me();
      add('OK', 'bot 身分', `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}（id=${me.id}）`);
    }));

    if (meOk) {
      // 5. Message Content Intent
      await step('Message Content Intent', async () => {
        const app = await client.application();
        if ((Number(app.flags) & MESSAGE_CONTENT) !== 0) add('OK', 'Message Content Intent', '已開啟');
        else {
          fail(
            'Message Content Intent',
            '沒有開啟：到 Discord Developer Portal → 你的 Application → Bot → Privileged Gateway Intents 打開 Message Content Intent，否則讀不到主導者的文字',
          );
        }
      });

      // 6. 頻道（404 代表 room.json 的 channelId 填錯，是設定問題）
      let channelOk = false;
      await step('頻道', async () => {
        let ch;
        try {
          ch = await client.channel(room.channelId);
        } catch (e) {
          if (e instanceof DiscordError && e.status === 404) {
            fail('頻道', `找不到頻道 ${room.channelId}：請檢查 room.json 的 channelId`, true);
            return;
          }
          throw e;
        }
        if (ch.guild_id !== room.guildId) {
          fail('頻道', `頻道 ${room.channelId} 不屬於 room.guildId ${room.guildId}（實際是 ${ch.guild_id ?? '無'}）`, true);
        } else if (THREAD_TYPES.has(ch.type)) {
          fail('頻道', `#${ch.name ?? room.channelId} 是討論串，尚未支援討論串；room.json 的 channelId 請填一般文字頻道`, true);
        } else if (!TEXT_TYPES.has(ch.type)) {
          add('WARN', '頻道', `#${ch.name ?? room.channelId} 的類型是 ${ch.type}，不是一般文字頻道，可能無法使用`);
          channelOk = true;
        } else {
          add('OK', '頻道', `#${ch.name ?? room.channelId}（伺服器 ${ch.guild_id}）`);
          channelOk = true;
        }
      });

      // 7. 讀取訊息歷史
      await step('讀取訊息', async () => {
        await client.messages(room.channelId, { limit: 1 });
        add('OK', '讀取訊息', '有讀取訊息歷史的權限');
      });

      // 7a. 主導者 ID 存在，印出名稱讓人確認沒填錯
      await step('主導者', async () => {
        try {
          const u = await client.user(room.moderatorUserId);
          add('OK', '主導者', `${u.global_name || u.username}（${u.username}，id=${u.id}）`);
        } catch (e) {
          if (e instanceof DiscordError && e.status === 404) {
            fail('主導者', `找不到使用者 ${room.moderatorUserId}：請檢查 room.json 的 moderatorUserId`, true);
          } else throw e;
        }
      });

      // 8. webhook：頻道有問題（填錯、不屬於這個伺服器、討論串）時不要在那裡建立 webhook。
      if (!channelOk) add('WARN', 'webhook', '頻道檢查沒通過，略過（不在錯的頻道建立 webhook）');
      else await step('webhook', async () => {
        try {
          const res = await ensureWebhook(client, room, { verify: true });
          webhook = res.webhook;
          add('OK', 'webhook', `${WEBHOOK_SOURCE_TEXT[res.source]}（${webhook.name}，id=${webhook.id}）`);
        } catch (e) {
          if (e instanceof DiscordError && e.status === 403) {
            throw new DiscordError(403, null, 'bot 沒有「管理 Webhook」權限，無法取得或建立 webhook');
          }
          throw e;
        }
      });

      // 9. 發測試訊息
      if (ctx.values['send-test']) {
        if (!webhook) add('WARN', '測試訊息', '沒有可用的 webhook，略過');
        else {
          await step('測試訊息', async () => {
            // 不用 agent 的名稱發：否則還沒 join 的名稱會因為這則測試訊息被 join 判成「24 小時內有人用過」。
            const username = `${room.webhookName}-doctor`;
            let msg;
            try {
              msg = await client.executeWebhook(webhook, { content: '[INFO] doctor 測試', username, allowedMentions: { parse: [] } });
            } catch (e) {
              if (e.uncertain) e.message += `，測試訊息可能已經送出，可用 ${readText(room)} 確認`;
              throw e;
            }
            add('OK', '測試訊息', `已送出（id=${msg.id}）`);
          });
        }
      }
    } else {
      skipped = true;
    }
  } else {
    skipped = true;
  }

  // 10. agent 的本機狀態
  if (ctx.values.as) {
    const problem = validateAgentName(ctx.values.as);
    if (problem) fail('agent 狀態', `--as ${ctx.values.as}：${problem}`, true);
    else if (room) {
      const state = loadAgent(room.channelId, ctx.values.as);
      if (!state) add('WARN', 'agent 狀態', `${ctx.values.as} 還沒在這個房間 join`);
      else add('OK', 'agent 狀態', `${ctx.values.as}：${summaryLine(state, room)}，游標 ${state.cursor}`);
    }
  }

  // 11. 設定提醒（§9）：API 位址被改過、.env 權限太寬。
  const apiBase = process.env.AGENTCHAT_API_BASE;
  if (apiBase && apiBase.replace(/\/+$/, '') !== DEFAULT_API_BASE) {
    let note = '';
    try {
      const u = new URL(apiBase);
      const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
      if (u.protocol !== 'https:' && !local) note = '（不是 https，也不是本機位址：bot token 會以明文送出）';
    } catch {
      note = '（不是合法網址）';
    }
    add('WARN', 'API 位址', `AGENTCHAT_API_BASE 不是預設值：${apiBase}${note}`);
  }
  try {
    const mode = fs.statSync(ENV_FILE).mode;
    if ((mode & 0o077) !== 0) {
      add('WARN', '.env 權限', `${ENV_FILE} 對群組或其他人開放（${(mode & 0o777).toString(8)}），請執行 chmod 600 ${ENV_FILE}`);
    }
  } catch {
    // 沒有 .env。
  }

  const count = (level) => checks.filter((c) => c.level === level).length;
  const fails = count('FAIL');
  const summaryText = `總結：OK ${count('OK')}、WARN ${count('WARN')}、FAIL ${fails}${skipped ? '（前面的檢查失敗，Discord 相關項目略過）' : ''}`;
  const code = fails ? (configFail ? 2 : 1) : 0;
  const text = [...checks.map((c) => `[${c.level}] ${c.item}：${c.message}`), summaryText];
  return {
    text,
    data: { checks, summary: summaryText },
    code,
    error: fails ? `doctor 有 ${fails} 項 FAIL` : undefined,
  };
}
