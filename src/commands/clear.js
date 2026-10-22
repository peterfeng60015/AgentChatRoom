import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { snowflakeToDate } from '../discord.js';
import { DiscordError, UserError } from '../errors.js';
import { validateAgentName } from '../protocol.js';
import { cleanText, oneLine } from '../render.js';
import { STATE_DIR, markCleared } from '../state.js';

export const summary = '（主導者用）永久刪除房間頻道的所有訊息，並清掉本機各 agent 的狀態';
export const usage = 'agentchat clear [--yes]';
export const options = { yes: { type: 'boolean', default: false } };
export const details = [
  '刪除頻道裡所有人的訊息（主導者、agent、其他人），無法復原；需要 bot 在頻道有「管理訊息」權限。',
  '這是主導者專用指令，agent 不可以執行（也不接受 --as）。主導者在自己的終端機執行，會要求輸入頻道名稱確認；主導者自己的腳本裡才加 --yes 跳過確認。',
  '刪完清掉本機 ~/.agentchat/agents/<頻道ID>/ 底下各 agent 的狀態檔與 wait 鎖，webhook 快取保留；logs/、downloads/ 仍留有被刪訊息的內容，要徹底清除請手動刪除。',
  '14 天內的訊息每批 100 則一起刪；更舊的逐則刪，數量多時會比較久。',
];

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const MANAGE_MESSAGES = 1n << 13n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ALL_PERMISSIONS = (1n << 64n) - 1n;
const THREAD_TYPES = new Set([10, 11, 12]);

// bulk-delete 只收 14 天內的訊息；留 1 小時餘裕給時鐘誤差，邊界附近的改成逐則刪。
const BULK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
const BULK_MAX = 100;

const perm = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

// Discord 的頻道權限算法：@everyone 與成員各角色的權限取聯集；有管理員就全部都有；
// 再依序套用頻道覆寫：@everyone、成員各角色（先 deny 後 allow 合併）、成員本人。
// 沒處理伺服器擁有者與被禁言（timeout）兩個特例：bot 幾乎不會遇到，萬一誤判，刪除時的 403 也會中止並說明。
export function channelPermissions({ guildId, userId, memberRoles = [], roles = [], overwrites = [] }) {
  const byId = new Map(roles.map((r) => [String(r.id), perm(r.permissions)]));
  let p = byId.get(String(guildId)) ?? 0n;
  for (const id of memberRoles) p |= byId.get(String(id)) ?? 0n;
  if (p & ADMINISTRATOR) return ALL_PERMISSIONS;
  const everyone = overwrites.find((o) => String(o.id) === String(guildId));
  if (everyone) p = (p & ~perm(everyone.deny)) | perm(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  const mine = new Set(memberRoles.map(String));
  for (const o of overwrites) {
    if (Number(o.type) === 0 && mine.has(String(o.id)) && String(o.id) !== String(guildId)) {
      allow |= perm(o.allow);
      deny |= perm(o.deny);
    }
  }
  p = (p & ~deny) | allow;
  const member = overwrites.find((o) => Number(o.type) === 1 && String(o.id) === String(userId));
  if (member) p = (p & ~perm(member.deny)) | perm(member.allow);
  return p;
}

// bot 在房間頻道的相關權限（clear 與 doctor 共用）。channel 是 GET /channels/<id> 的結果。
export async function botChannelAccess(client, room, channel) {
  const me = await client.me();
  const [member, roles] = await Promise.all([client.guildMember(room.guildId, me.id), client.guildRoles(room.guildId)]);
  const p = channelPermissions({
    guildId: room.guildId,
    userId: me.id,
    memberRoles: member?.roles || [],
    roles: Array.isArray(roles) ? roles : [],
    overwrites: channel?.permission_overwrites || [],
  });
  const has = (bit) => (p & bit) === bit;
  return { view: has(VIEW_CHANNEL), readHistory: has(READ_MESSAGE_HISTORY), manageMessages: has(MANAGE_MESSAGES) };
}

const PERMISSION_NAMES = { 檢視頻道: 'View Channels', 讀取訊息歷史: 'Read Message History', 管理訊息: 'Manage Messages' };

// 缺權限時的修正方法（doctor 也用）。
export function permissionFix(label = '管理訊息') {
  const en = PERMISSION_NAMES[label];
  return (
    `到 Discord 的伺服器設定 → 角色，給 bot 的角色勾「${label}」（${en}），或在頻道設定 → 權限對 bot（或它的角色）允許「${label}」；` +
    `也可以用 OAuth2 → URL Generator 多勾 ${en} 重新邀請 bot`
  );
}

function permissionError(channelName, label = '管理訊息') {
  return new DiscordError(403, null, `bot 在 #${channelName} 沒有「${label}」權限，無法清空頻道：${permissionFix(label)}`);
}

// 由新到舊翻頁，取得頻道目前所有訊息的 ID。
async function allMessageIds(client, channelId) {
  const ids = [];
  let before;
  for (;;) {
    const batch = await client.messages(channelId, { before, limit: 100 });
    if (!batch.length) break;
    ids.push(...batch.map((m) => m.id));
    if (batch.length < 100) break;
    before = batch[0].id; // messages() 由舊到新，第一則最舊
  }
  return ids;
}

function askLine(stdin, prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, terminal: false });
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) resolve(null);
    });
    process.stderr.write(cleanText(prompt));
  });
}

// 清掉這台機器上本房各 agent 的狀態檔、wait 鎖與暫存檔（整個 agents/<頻道ID>/ 目錄），回傳清掉的 agent 名稱。
// 之後為這些 agent（加上之前清過、還沒重新 join 的）留清除標記；寫標記失敗只回傳警告。
function clearAgentStates(channelId) {
  const dir = path.join(STATE_DIR, 'agents', String(channelId));
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { dir, agents: [], markError: null };
    throw new UserError(`讀不到本機狀態目錄：${dir}（${e.code || e.message}）`);
  }
  // 標記檔名由名稱決定，檔案裡的名稱不合法（壞掉或被改過）就改用檔名，免得寫到目錄外。
  const nameIn = (f, ext) => {
    const stem = f.slice(0, -ext.length);
    try {
      const name = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name;
      return typeof name === 'string' && !validateAgentName(name) ? name : stem;
    } catch {
      return stem;
    }
  };
  const agents = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => nameIn(f, '.json'))
    .sort();
  const marked = new Set(agents);
  for (const f of files.filter((f) => f.endsWith('.cleared'))) marked.add(nameIn(f, '.cleared'));
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); // 別的行程剛好在目錄裡建鎖檔時重試
  } catch (e) {
    throw new UserError(`清除本機狀態目錄失敗：${dir}（${e.code || e.message}）`);
  }
  let markError = null;
  try {
    markCleared(channelId, [...marked]);
  } catch (e) {
    markError = e.code || e.message;
  }
  return { dir, agents, markError };
}

export async function run(ctx) {
  if (ctx.values.as !== undefined) {
    throw new UserError('clear 是主導者在終端機用的指令，不接受 --as（agent 不可以執行 clear）');
  }
  if (ctx.positionals.length) throw new UserError(`多餘的參數：${ctx.positionals.join(' ')}`);
  const room = ctx.room;
  const client = ctx.client;

  const channel = await client.channel(room.channelId);
  if (channel.guild_id !== room.guildId) {
    throw new UserError(`頻道 ${room.channelId} 不屬於 room.guildId ${room.guildId}（實際是 ${channel.guild_id ?? '無'}），不清空：請檢查 ${room.file}`);
  }
  if (THREAD_TYPES.has(channel.type)) {
    throw new UserError(`頻道 ${room.channelId} 是討論串，尚未支援討論串，不清空：請檢查 ${room.file}`);
  }
  const name = oneLine(channel.name ?? room.channelId);
  const access = await botChannelAccess(client, room, channel);
  if (!access.view) throw permissionError(name, '檢視頻道');
  if (!access.readHistory) throw permissionError(name, '讀取訊息歷史');
  if (!access.manageMessages) throw permissionError(name);

  const ids = await allMessageIds(client, room.channelId);
  const stateDir = path.join(STATE_DIR, 'agents', String(room.channelId));

  if (!ctx.values.yes) {
    const expected = String(channel.name ?? room.channelId);
    if (!ctx.stdin?.isTTY) {
      throw new UserError(
        `clear 是主導者專用指令，agent 不可以執行；主導者請在自己的終端機執行（會要求輸入頻道名稱確認），或在自己的腳本裡加 --yes`,
      );
    }
    const answer = await askLine(
      ctx.stdin,
      [
        `即將永久刪除 #${name}（頻道 ${room.channelId}）目前的 ${ids.length} 則訊息（主導者、agent、其他人的都刪），無法復原；`,
        `並清除本機 ${stateDir} 底下各 agent 的狀態檔與 wait 鎖（webhook 快取保留）。`,
        `確認請輸入頻道名稱 ${name}：`,
      ].join('\n'),
    );
    const typed = String(answer ?? '').trim().replace(/^#/, '');
    if (typed !== expected) throw new UserError('輸入的頻道名稱不符，已中止，沒有刪除任何訊息');
  }

  const cutoff = Date.now() - BULK_MAX_AGE_MS;
  const recent = ids.filter((id) => snowflakeToDate(id).getTime() > cutoff);
  const old = ids.filter((id) => snowflakeToDate(id).getTime() <= cutoff);
  let bulkDeleted = 0;
  let singleDeleted = 0;
  let skipped = 0;
  const failedIds = [];

  const abort = (e) => {
    const done = `中止前已刪除 ${bulkDeleted + singleDeleted} 則，本機狀態沒有清除；處理好後重新執行 clear 繼續`;
    if (e instanceof DiscordError && e.status === 403) {
      const err = permissionError(name);
      const raw = e.data && typeof e.data === 'object' && e.data.message ? `Discord 回應：${e.data.message}；` : '';
      err.message += `（${raw}${done}）`;
      return err;
    }
    if (e instanceof DiscordError) e.message += `（${done}）`;
    return e;
  };

  const deleteOne = async (id) => {
    try {
      await client.deleteMessage(room.channelId, id);
      singleDeleted++;
    } catch (e) {
      if (!(e instanceof DiscordError)) throw e;
      if (e.status === 404) skipped++;
      else if (e.status === 400) failedIds.push(id); // 例如不能刪的系統訊息
      else throw abort(e);
    }
  };

  for (let i = 0; i < recent.length; i += BULK_MAX) {
    const chunk = recent.slice(i, i + BULK_MAX);
    if (chunk.length === 1) {
      await deleteOne(chunk[0]);
      continue;
    }
    try {
      await client.bulkDelete(room.channelId, chunk);
      bulkDeleted += chunk.length;
    } catch (e) {
      // 400：批次裡有超過 14 天、已被刪掉或不能刪的訊息，改成逐則刪找出是哪幾則。
      if (!(e instanceof DiscordError) || e.status !== 400) throw abort(e);
      for (const id of chunk) await deleteOne(id);
    }
  }
  for (const id of old) await deleteOne(id);

  const cleared = clearAgentStates(room.channelId);
  const deleted = bulkDeleted + singleDeleted;
  const failed = failedIds.length;
  const text = [
    `已清空 #${name}：刪除 ${deleted} 則（其中逐則刪除 ${singleDeleted} 則），略過 ${skipped} 則（已不存在），失敗 ${failed} 則`,
  ];
  if (failed) text.push(`刪除失敗的訊息 ID：${failedIds.slice(0, 10).join(', ')}${failed > 10 ? ` 等 ${failed} 則` : ''}`);
  text.push(
    cleared.agents.length
      ? `已清除本機 ${cleared.agents.length} 個 agent 的狀態檔與 wait 鎖（${cleared.agents.map(oneLine).join('、')}）：${cleared.dir}；webhook 快取保留`
      : `本機沒有這個房間的 agent 狀態（${cleared.dir}）；webhook 快取保留`,
  );
  if (cleared.markError) {
    text.push(`警告：清除標記寫入失敗（${cleared.markError}），還在跑的 agent 下一個指令會被提示 join 而不是停下來`);
  }
  text.push('agent 在別台機器時，那台的狀態不會被清；要讓 agent 回來，叫它重新 join（不要帶 --resume）');
  return {
    text,
    data: {
      channel: { id: room.channelId, name: channel.name ?? null },
      total: ids.length,
      deleted,
      bulkDeleted,
      singleDeleted,
      skipped,
      failed,
      failedIds,
      clearedAgents: cleared.agents,
      stateDir: cleared.dir,
      markError: cleared.markError,
    },
    code: failed ? 1 : 0,
    error: failed ? `有 ${failed} 則訊息刪除失敗` : undefined,
  };
}
