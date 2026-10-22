// §6.3 avatar：替 agent 建立或更新專屬 webhook，用它的頭像顯示 agent 自己畫的圖。不發訊息、不改 agent 狀態。
import fs from 'node:fs';
import path from 'node:path';
import { compareSnowflake } from '../discord.js';
import { DiscordError, ProtocolError, UserError } from '../errors.js';
import { LEFT_TEXT } from '../protocol.js';
import { agentWebhookName, rememberRoomWebhook, requireAgent } from '../context.js';
import { checkSecretPath, guardSecrets } from '../publish.js';
import { clearAgentWebhook, loadAgentWebhook, saveAgentWebhook } from '../state.js';

export const summary = '設定你自己的頭像（PNG／JPG／GIF），之後的發言顯示這張圖';
export const usage = 'agentchat avatar --as <名稱> --file <圖檔>';
export const options = { file: { type: 'string' } };
export const details = [
  '圖檔只接受 PNG、JPEG、GIF（看檔頭，不看副檔名），大小不超過 8 MB；建議 256×256 左右的 PNG。',
  '第一次執行時在房間頻道建立你的專屬 webhook，之後執行只更新它的頭像；發言時改經由它送出，顯示名稱不變。',
  '需要 bot 有「管理 Webhook」權限；每個頻道最多 15 個 webhook。',
];

// Discord 官方文件沒有寫明 webhook 頭像的上限，這是工具自訂的（§6.3 avatar）。
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

// 看檔頭判斷格式；不認得回 null。
export function imageFormat(data) {
  const starts = (bytes) => bytes.every((b, i) => data[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: 'png', mime: 'image/png' };
  if (starts([0xff, 0xd8, 0xff])) return { format: 'jpeg', mime: 'image/jpeg' };
  const head = data.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return { format: 'gif', mime: 'image/gif' };
  return null;
}

function readImage(file) {
  const abs = path.resolve(file);
  checkSecretPath(abs, '--file ');
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new UserError(`找不到圖檔：${abs}`);
  }
  if (!stat.isFile()) throw new UserError(`圖檔不是一般檔案：${abs}`);
  if (stat.size > MAX_AVATAR_BYTES) throw new UserError(`圖檔超過 8 MB：${abs}；頭像建議 256×256 左右的 PNG`);
  let data;
  try {
    data = fs.readFileSync(abs);
  } catch (e) {
    throw new UserError(`圖檔讀不到：${abs}（${e.code || e.message}）`);
  }
  if (data.length > MAX_AVATAR_BYTES) throw new UserError(`圖檔超過 8 MB：${abs}；頭像建議 256×256 左右的 PNG`);
  if (!data.length) throw new UserError(`圖檔是空的：${abs}`);
  const type = imageFormat(data);
  if (!type) throw new UserError(`不是 PNG、JPEG 或 GIF 圖檔（看檔頭判斷）：${abs}；SVG 要先轉成 PNG`);
  return { abs, data, ...type };
}

// 50035（Invalid Form Body）是通用的表單錯誤：errors 樹指出別的欄位（例如 webhook 名稱含 discord）時不是圖的問題，
// 保留 Discord 的原因；沒有 errors 樹或指出 avatar 時才當成圖被拒。
function avatarRejected(data) {
  const errors = data && typeof data === 'object' ? data.errors : null;
  if (!errors || typeof errors !== 'object') return true;
  return Object.prototype.hasOwnProperty.call(errors, 'avatar');
}

// Discord 拒絕時換成看得懂的說明（§6.3 avatar 第 3 步）。
function explain(e) {
  if (!(e instanceof DiscordError)) return e;
  const code = e.data && typeof e.data === 'object' ? e.data.code : undefined;
  if (e.status === 403) {
    return new DiscordError(403, e.data, 'bot 沒有「管理 Webhook」權限，無法建立或修改專屬 webhook；請主導者在伺服器或頻道設定給 bot 的角色勾上「管理 Webhook」');
  }
  if (code === 30007) {
    return new DiscordError(
      e.status,
      e.data,
      '這個頻道的 webhook 已達 Discord 上限 15 個，無法建立專屬 webhook；請主導者用 agentchat clear 清掉專屬 webhook，或到頻道設定 → 整合 → Webhook 刪掉不用的',
    );
  }
  if (e.status === 413 || [50138, 40005, 50045].includes(code) || (e.status === 400 && code === 50035 && avatarRejected(e.data))) {
    return new DiscordError(e.status, e.data, 'Discord 拒收這張頭像，請換一張小一點的 PNG（例如 256×256）');
  }
  return e;
}

// 本機快取 → 頻道裡同名且有 token 的 → 建立新的（§6.3 avatar 第 3 步）。
async function applyAvatar(client, room, name, avatar) {
  const webhookName = agentWebhookName(room, name);
  const save = (hook) => {
    const webhook = { id: hook.id, token: hook.token, channelId: room.channelId, name: hook.name ?? webhookName, agent: name };
    saveAgentWebhook(room.channelId, name, webhook);
    return webhook;
  };
  const cached = loadAgentWebhook(room.channelId, name);
  if (cached) {
    try {
      const info = await client.modifyWebhook(cached.id, cached.token, { avatar });
      return { webhook: save({ ...cached, name: info?.name ?? cached.name }), source: 'updated' };
    } catch (e) {
      if (!(e instanceof DiscordError) || ![401, 404].includes(e.status)) throw e;
      // 先記進辨識快取的 room：快取刪掉後，這個 webhook 以前發的訊息才不會被當成陌生 webhook（§4.5）。
      rememberRoomWebhook(room.channelId, cached.id);
      clearAgentWebhook(room.channelId, name);
    }
  }
  const list = await client.listWebhooks(room.channelId);
  const found = (Array.isArray(list) ? list : [])
    .filter((w) => w?.name === webhookName && w.token && /^\d+$/.test(String(w.id)))
    .sort((a, b) => compareSnowflake(a.id, b.id))[0];
  if (found) {
    try {
      const info = await client.modifyWebhook(found.id, found.token, { avatar });
      return { webhook: save({ ...found, name: info?.name ?? found.name }), source: 'found' };
    } catch (e) {
      // 查清單之後才被刪掉（或 token 已失效）：和快取失效一樣，改建新的。
      if (!(e instanceof DiscordError) || ![401, 404].includes(e.status)) throw e;
      rememberRoomWebhook(room.channelId, found.id);
    }
  }
  const created = await client.createWebhook(room.channelId, webhookName, avatar);
  if (!created?.id || !created?.token) throw new DiscordError(0, null, '建立的專屬 webhook 沒有 token，無法用來發言');
  return { webhook: save(created), source: 'created' };
}

const SOURCE_TEXT = {
  created: '建立新的專屬 webhook',
  updated: '更新專屬 webhook',
  found: '沿用頻道裡既有的專屬 webhook',
};

export async function run(ctx) {
  const room = ctx.room;
  const state = requireAgent(ctx);
  if (state.left || state.phase === 'left') throw new ProtocolError(LEFT_TEXT);
  if (ctx.positionals.length) throw new UserError(`多餘的參數：${ctx.positionals.join(' ')}；圖檔請用 --file <路徑>`);
  if (!ctx.values.file) throw new UserError('缺少 --file <圖檔>（PNG、JPEG 或 GIF）');
  const image = readImage(ctx.values.file);
  guardSecrets(room, '', [{ filename: path.basename(image.abs), data: image.data }]);
  const avatar = `data:${image.mime};base64,${image.data.toString('base64')}`;
  let result;
  try {
    result = await applyAvatar(ctx.client, room, state.name, avatar);
  } catch (e) {
    throw explain(e);
  }
  const { webhook, source } = result;
  return {
    text: [`已設定 ${state.name} 的頭像（${SOURCE_TEXT[source]}，${webhook.name}，id=${webhook.id}）`, '之後的發言會顯示這張頭像'],
    data: { name: state.name, webhook: { id: webhook.id, name: webhook.name }, source, bytes: image.data.length, format: image.format },
  };
}
