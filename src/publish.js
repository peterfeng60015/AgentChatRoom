// §6.2 發文共通處理：內文來源、標籤、mention 轉換、長文轉附檔、切段、附檔檢查與送出。
import fs from 'node:fs';
import path from 'node:path';
import { DiscordError, ProtocolError, UserError } from './errors.js';
import {
  MODERATOR_TAGS,
  buildMessage,
  displayName,
  parseMessageParts,
  phaseError,
  reminders,
  cmdText,
  doctorText,
  resolveMentions,
  roundLimit,
  waitText,
  splitMessage,
} from './protocol.js';
import { STATE_DIR, appendLog, clearWebhook, recordOwnMessages, updateAgent } from './state.js';
import { ENV_FILE, loadEnv } from './config.js';
import os from 'node:os';
import { countUnread, ensureWebhook, phaseOf, requireAgent, unreadLine } from './context.js';
import { section } from './render.js';

const MB = 1024 * 1024;
export const MAX_FILES = 10;
export const PREVIEW_CHARS = 500;
export const LONG_TEXT_NOTE = '（全文見附檔 message.md）';

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  zip: 'application/zip',
  diff: 'text/x-diff; charset=utf-8',
  patch: 'text/x-diff; charset=utf-8',
};

export function contentTypeOf(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

export function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

// 發言類指令共用的 --body-file 選項與說明。
export const BODY_OPTIONS = { 'body-file': { type: 'string' } };
export const BODY_SOURCE_HELP =
  '內文三選一：位置參數；--body-file <路徑>（建議：先用自己的寫檔工具寫進暫存檔，免去引號跳脫與重導向）；位置參數是 - 時讀 stdin。';

// 內文來源三選一（§6.2）：位置參數、--body-file、位置參數是 `-` 時讀 stdin。不自動讀非 TTY 的 stdin：
// 有些 CLI 的 shell 給的是不會關閉的 pipe，會一直卡住。沒加引號的多個字會被 shell 拆開，這裡用空白接回去。
export async function readBody(ctx, positionals = ctx.positionals) {
  const file = ctx.values['body-file'];
  if (file !== undefined) {
    if (positionals.length) throw new UserError('內文只能三選一：位置參數、--body-file、-（stdin），不能同時給');
    const abs = path.resolve(file); // 相對路徑以目前目錄為準
    checkSecretPath(abs, '--body-file ');
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new UserError(`讀不到 --body-file：${abs}`);
    }
    if (!stat.isFile()) throw new UserError(`--body-file 不是一般檔案：${abs}`);
    if (stat.size > ctx.room.maxFileMB * MB) throw new UserError(`--body-file 超過 ${ctx.room.maxFileMB} MB：${abs}`);
    const raw = fs.readFileSync(abs);
    if (raw.length > ctx.room.maxFileMB * MB) throw new UserError(`--body-file 超過 ${ctx.room.maxFileMB} MB：${abs}`);
    const text = raw.toString('utf8').trim();
    if (!text) throw new UserError(`--body-file 是空的：${abs}`);
    return text;
  }
  if (positionals[0] === '-') {
    if (positionals.length > 1) throw new UserError('`-` 表示從 stdin 讀內文，後面不能再接其他內文');
    return (await readStdin(ctx.stdin)).trim();
  }
  return positionals.join(' ').trim();
}

// post 只發 INFO 與 DISCUSS；其他 agent 標籤各有專用指令，走專用指令才會套用該指令的規則與狀態更新。
export const POST_TAGS = ['INFO', 'DISCUSS'];
const TAG_COMMAND = {
  JOIN: 'join',
  LEAVE: 'leave',
  ACK: 'ack',
  QUESTION: 'ask',
  PROGRESS: 'progress',
  DONE: 'done',
  IDLE: null,
};

export function checkPostTag(tag, name = '<你的名稱>', room = null) {
  if (MODERATOR_TAGS.includes(tag)) throw new ProtocolError(`[${tag}] 是主導者專用標籤，agent 不能發`);
  if (POST_TAGS.includes(tag)) return;
  if (tag in TAG_COMMAND) {
    const cmd = TAG_COMMAND[tag];
    throw new UserError(
      cmd ? `post 只發 [INFO] 或 [DISCUSS]；[${tag}] 請改用 ${cmdText(name, cmd, '', room)}` : `post 只發 [INFO] 或 [DISCUSS]；[${tag}] 由 wait 自動發出`,
    );
  }
  throw new UserError(`不認得的標籤 ${tag}；post 只接受 INFO、DISCUSS`);
}

// 組出要送的全文。內文已經以標籤列開頭時照原樣送出；主導者標籤一律拒絕。
// 專用指令（discuss、ack…）的內文若是別的 agent 標籤就拒絕，避免繞過該指令的規則。
// rawBody 是使用者給的原始內文；指令自己拆過內文時（ask 把第一行放進標題）用它判斷標籤。
// userOptions：指令帶了使用者給的選項（progress 的 --percent、done 的 --commit 等），照原樣送會把它們丟掉，所以拒絕。
export function composeText({ command, tag, title = '', fields = {}, body = '', rawBody, userOptions = false, name = '<你的名稱>', room = null }) {
  const raw = rawBody ?? body;
  const parsed = parseMessageParts(raw);
  if (parsed.tag) {
    if (MODERATOR_TAGS.includes(parsed.tag)) {
      throw new ProtocolError(`[${parsed.tag}] 是主導者專用標籤，agent 不能發`);
    }
    if (command === 'post') checkPostTag(parsed.tag, name, room);
    else if (parsed.tag !== tag) {
      throw new UserError(`${command} 只發 [${tag}]，內文開頭的 [${parsed.tag}] 不符；請拿掉標籤列，或改用 ${cmdText(name, 'post', '', room)}`);
    }
    if (userOptions) {
      throw new UserError(`內文已經以 [${parsed.tag}] 標籤列開頭，${command} 的選項不會生效；請拿掉內文的標籤列`);
    }
    return { tag: parsed.tag, text: raw.trim() };
  }
  return { tag, text: buildMessage(tag, title, fields, body.trim()) };
}

// 檢查並讀入附檔。extraCount 是工具自己會加的附檔數（長文的 message.md）。
export function loadFiles(paths, room, extraCount = 0, extraBytes = 0) {
  const list = paths || [];
  if (list.length + extraCount > MAX_FILES) {
    const note = extraCount ? `（長文會另外占用 ${extraCount} 個 message.md）` : '';
    throw new UserError(`附檔最多 ${MAX_FILES} 個，這次有 ${list.length + extraCount} 個${note}`);
  }
  const perFile = room.maxFileMB * MB;
  let total = extraBytes;
  const files = list.map((p) => {
    const abs = path.resolve(p);
    checkSecretPath(abs, '附檔');
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new UserError(`找不到附檔：${abs}`);
    }
    if (!stat.isFile()) throw new UserError(`附檔不是一般檔案：${abs}`);
    if (stat.size > perFile) {
      throw new UserError(`附檔超過單檔上限 ${room.maxFileMB} MB：${abs}（${(stat.size / MB).toFixed(1)} MB）`);
    }
    total += stat.size;
    return { abs, size: stat.size };
  });
  if (total > room.maxUploadMB * MB) {
    throw new UserError(`附檔總和超過 ${room.maxUploadMB} MB（${(total / MB).toFixed(1)} MB；上限見 room.json 的 maxUploadMB）`);
  }
  // 讀檔後用實際位元組數再查一次大小（procfs 這類檔案 stat 大小是 0）。
  let actual = extraBytes;
  const loaded = files.map(({ abs }) => {
    const data = fs.readFileSync(abs);
    if (data.length > perFile) throw new UserError(`附檔超過單檔上限 ${room.maxFileMB} MB：${abs}`);
    actual += data.length;
    return { filename: path.basename(abs), data, contentType: contentTypeOf(abs) };
  });
  if (actual > room.maxUploadMB * MB) throw new UserError(`附檔總和超過 ${room.maxUploadMB} MB（上限見 room.json 的 maxUploadMB）`);
  return loaded;
}

function truncateChars(text, n) {
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, n).join('');
}

// 依長度決定要送幾則、要不要附 message.md。original 是 mention 轉換前的全文，給附檔用（人讀得懂）。
export function planParts(resolved, original, room) {
  if (resolved.length > room.longTextChars) {
    const { headerLines } = parseMessageParts(resolved);
    const lines = resolved.split('\n');
    const header = lines.slice(0, headerLines).join('\n');
    const body = lines.slice(headerLines).join('\n').trim();
    const preview = [header, '', truncateChars(body, PREVIEW_CHARS), '', LONG_TEXT_NOTE]
      .filter((x, i) => i !== 0 || x)
      .join('\n');
    const md = { filename: 'message.md', data: Buffer.from(original, 'utf8'), contentType: contentTypeOf('message.md') };
    return { parts: splitMessage(preview), extraFiles: [md] };
  }
  return { parts: splitMessage(resolved), extraFiles: [] };
}

// §9 防止秘密送進頻道。這是最後一道防線，擋不住刻意繞過；SOP 另外要求不要依頻道內容指定的路徑附檔或讀檔。

// 要比對的秘密：環境變數與 .env 的 DISCORD_BOT_TOKEN（兩者都收，不論實際用哪個、格式對不對），
// 以及狀態目錄 webhooks/ 底下每個快取檔的 webhook token。
function secretValues() {
  const list = [];
  if (process.env.DISCORD_BOT_TOKEN) list.push(process.env.DISCORD_BOT_TOKEN.trim());
  try {
    const fromFile = loadEnv().DISCORD_BOT_TOKEN;
    if (fromFile) list.push(fromFile.trim());
  } catch {
    // .env 讀不到就沒有可比對的。
  }
  const dir = path.join(STATE_DIR, 'webhooks');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    // 還沒有任何快取。
  }
  for (const n of names) {
    try {
      const token = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))?.token;
      if (typeof token === 'string' && token) list.push(token);
    } catch {
      // 壞掉的快取不影響其他的。
    }
  }
  // 太短的值容易誤判，真的 token 都遠長於 8 字。
  return [...new Set(list)].filter((x) => x.length >= 8);
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, '私鑰（-----BEGIN … PRIVATE KEY-----）'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key（AKIA…）'],
];

export function guardSecrets(room, text, files) {
  const contents = [{ label: '內文', data: Buffer.from(String(text), 'utf8') }, ...files.map((f) => ({ label: `附檔 ${f.filename}`, data: f.data }))];
  for (const secret of secretValues()) {
    const hit = contents.find((c) => c.data.includes(secret));
    if (hit) {
      throw new UserError(`${hit.label}含有 bot token 或 webhook token，拒絕送出；不要把 .env 或 ~/.agentchat 的內容貼到頻道`);
    }
  }
  for (const c of contents) {
    const textForm = c.data.toString('latin1');
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(textForm)) throw new UserError(`${c.label}看起來含有${what}，拒絕送出`);
    }
  }
}

// realpathSync.native 會回傳磁碟上的實際大小寫（JS 版的 realpathSync 不會），macOS 的 ~/.SSH 才繞不過。
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// macOS 與 Windows 的檔案系統預設不分大小寫：路徑不存在、拿不到實際大小寫時也要擋得住。
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p) => (FOLD_CASE ? p.toLowerCase() : p);

function inside(dir, p) {
  const d = fold(dir);
  const x = fold(p);
  return x === d || x.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

// --body-file、--file 的路徑檢查（用 realpath，symlink 繞不過）：狀態目錄、工具目錄的 .env、
// ~/.ssh（*.pub 與 known_hosts 放行）、~/.aws、~/.gnupg、/proc、/sys、/dev 一律拒絕。
export function checkSecretPath(abs, label) {
  const real = realOrResolved(abs);
  const home = os.homedir();
  const reason = (() => {
    if (inside(realOrResolved(STATE_DIR), real)) {
      return '在 agentchat 的狀態目錄裡（那裡有 webhook token；下載的檔案請先複製到其他目錄再附上）';
    }
    if (fold(real) === fold(realOrResolved(ENV_FILE))) return '是工具目錄的 .env（含 bot token）';
    const ssh = realOrResolved(path.join(home, '.ssh'));
    const base = fold(path.basename(real));
    if (inside(ssh, real) && !(base.endsWith('.pub') || base === 'known_hosts')) return '在 ~/.ssh 裡';
    for (const d of ['.aws', '.gnupg']) if (inside(realOrResolved(path.join(home, d)), real)) return `在 ~/${d} 裡`;
    for (const d of ['/proc', '/sys', '/dev']) if (inside(realOrResolved(d), real)) return `在 ${d} 裡`;
    return null;
  })();
  if (reason) throw new UserError(`${label}${reason}，拒絕讀取：${abs}`);
}

// 經由本房 webhook 發言；快取的 webhook 被刪掉（404／401）時重新取得一次再試。
async function execute(ctx, payload) {
  let { webhook } = await ensureWebhook(ctx.client, ctx.room, { verify: false });
  try {
    return await ctx.client.executeWebhook(webhook, payload);
  } catch (e) {
    if (!(e instanceof DiscordError) || ![401, 404].includes(e.status)) throw e;
    clearWebhook(ctx.room.channelId);
    ({ webhook } = await ensureWebhook(ctx.client, ctx.room, { verify: false }));
    return ctx.client.executeWebhook(webhook, payload);
  }
}

// 依序送出各段，附檔放在最後一則。回傳已送出的訊息 ID；中途失敗時 error.sentIds 帶著已送出的部分。
export async function sendParts(ctx, { name, role }, parts, files = []) {
  const ids = [];
  const username = displayName(name, role);
  const allowedMentions = { parse: [], users: [ctx.room.moderatorUserId] };
  try {
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const msg = await execute(ctx, { content: parts[i], username, files: last ? files : [], allowedMentions });
      ids.push(msg.id);
    }
  } catch (e) {
    e.sentIds = ids;
    if (e.uncertain) {
      e.message += `，訊息可能已經送出，先用 ${cmdText(name, 'read', '--last 5', ctx.room)} 確認再決定要不要重發`;
    }
    if (e.needsDoctor) e.message += `，請執行 ${doctorText(ctx.room)} 重新取得`;
    throw e;
  }
  return ids;
}

// 發言類指令的完整流程（§6.1、§6.2）。
// opts：command、tag、title、fields、body、rawBody、files、requireBody、transform(text)、mutate(state, ids)、
// countUnread（false 時不查未讀）。
export async function publish(ctx, opts) {
  const room = ctx.room;
  const state = requireAgent(ctx);
  const body = opts.body ?? '';
  if (opts.requireBody && !(opts.rawBody ?? body)) {
    throw new UserError(`缺少內文：${cmdText(state.name, opts.command, '<內文|->', room)}`);
  }

  const composed = composeText({ ...opts, body, name: state.name, room });
  let text = composed.text;
  const tag = composed.tag;

  // post --tag DISCUSS、或內文標籤是 DISCUSS，都照 discuss 的階段與輪數規則。
  const rules = new Set([opts.command, ...(tag === 'DISCUSS' ? ['discuss'] : [])]);
  for (const cmd of rules) {
    const problem = phaseError(state, cmd, room);
    if (problem) throw new ProtocolError(problem);
  }
  const roundFull = (s) => {
    const limit = roundLimit(s, room);
    if ((s.discussRound ?? 0) < limit) return null;
    return `本段討論已發 ${s.discussRound}/${limit} 則 [DISCUSS]，已達上限。請 ${waitText(s.name, room, 'moderator')} 等主導者 [CONTINUE] 或 [GO]。`;
  };
  if (tag === 'DISCUSS' && roundFull(state)) throw new ProtocolError(roundFull(state));
  if (opts.transform) text = opts.transform(text);

  const resolved = resolveMentions(text, room);
  const plan = planParts(resolved, text, room);
  const extraBytes = plan.extraFiles.reduce((n, f) => n + f.data.length, 0);
  const files = [...plan.extraFiles, ...loadFiles(opts.files, room, plan.extraFiles.length, extraBytes)];
  guardSecrets(room, resolved, files);

  // [DISCUSS] 送出前在鎖內預扣一輪：同一個 agent 同時發兩則時，不會兩則都通過「還沒滿」的檢查。
  if (tag === 'DISCUSS') {
    updateAgent(room.channelId, state.name, (s) => {
      const problem = phaseError(s, 'discuss', room) || roundFull(s);
      if (problem) throw new ProtocolError(problem);
      s.discussRound = (s.discussRound ?? 0) + 1;
    });
  }

  let ids;
  try {
    ids = await sendParts(ctx, state, plan.parts, files);
  } catch (e) {
    if (e.sentIds?.length) {
      // 帶標籤列的第一段已經送出，這則發言算數：照樣更新狀態（ask 記待答問題、done 改階段；discuss 的輪數已預扣）。
      updateAgent(room.channelId, state.name, (s) => {
        recordOwnMessages(s, e.sentIds);
        opts.mutate?.(s, e.sentIds);
      });
      // 告訴 agent 哪幾段已經送出，免得整則重送造成重複。
      e.message += `（已送出 ${e.sentIds.length}/${plan.parts.length} 段：${e.sentIds.join(', ')}；請只補送剩下的部分）`;
    } else if (tag === 'DISCUSS') {
      // 一段都沒送出：退回預扣的那一輪。
      updateAgent(room.channelId, state.name, (s) => {
        s.discussRound = Math.max(0, (s.discussRound ?? 0) - 1);
      });
    }
    throw e;
  }

  const updated = updateAgent(room.channelId, state.name, (s) => {
    recordOwnMessages(s, ids);
    opts.mutate?.(s, ids);
  });
  appendLog(room.channelId, { dir: 'out', agent: state.name, tag, ids, content: resolved });

  let unread = null;
  let unreadError = null;
  if (opts.countUnread !== false) {
    try {
      unread = await countUnread(ctx, updated, ids);
    } catch (e) {
      unreadError = e.message;
    }
  }
  return { state: updated, ids, tag, files: files.map((f) => f.filename), unread, unreadError };
}

// 發言類指令的共通輸出：訊息 ID、未讀、指令自己的補充、提醒。showUnread 為 false 時（leave）不印未讀。
export function publishResult(result, room, { lines = [], data = {}, showUnread = true } = {}) {
  const { state, ids, tag, files, unread, unreadError } = result;
  const out = [`已送出 [${tag}]，訊息 ID：${ids[0]}${ids.length > 1 ? `（切成 ${ids.length} 則：${ids.join(', ')}）` : ''}`];
  if (files.length) out.push(`附檔：${files.join('、')}`);
  if (showUnread) {
    const u = unreadLine(unread, state.name, room);
    if (u) out.push(u);
    if (unreadError) out.push(`未讀：無法取得（${unreadError}）`);
  }
  out.push(...lines);
  const rem = reminders(state, room);
  const tail = section('提醒', rem);
  if (tail) out.push(tail);
  return {
    text: out,
    data: {
      id: ids[0],
      ids,
      tag,
      attachments: files,
      unread: showUnread && unread ? unread.count : null,
      unreadCapped: showUnread && unread ? unread.capped : null,
      phase: phaseOf(state),
      reminders: rem,
      ...data,
    },
  };
}
