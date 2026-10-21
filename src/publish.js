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
  resolveMentions,
  roundLimit,
  splitMessage,
} from './protocol.js';
import { appendLog, clearWebhook, recordOwnMessages, updateAgent } from './state.js';
import { ensureWebhook, fetchUnread, phaseOf, requireAgent, unreadLine } from './context.js';
import { section } from './render.js';

const MB = 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 25 * MB;
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

// 內文來源：位置參數；位置參數是 `-`，或沒有位置參數且 stdin 不是 TTY 時讀 stdin。
// 沒加引號的多個字會被 shell 拆成多個位置參數，這裡用空白接回去。
export async function readBody(ctx, positionals = ctx.positionals) {
  if (positionals.length === 1 && positionals[0] === '-') return (await readStdin(ctx.stdin)).trim();
  if (positionals.length) return positionals.join(' ').trim();
  if (ctx.stdin && !ctx.stdin.isTTY) return (await readStdin(ctx.stdin)).trim();
  return '';
}

// 組出要送的全文。內文已經以標籤列開頭時照原樣送出；主導者標籤一律拒絕。
// 專用指令（discuss、ack…）的內文若是別的 agent 標籤就拒絕，避免繞過該指令的規則。
// rawBody 是使用者給的原始內文；指令自己拆過內文時（ask 把第一行放進標題）用它判斷標籤。
export function composeText({ command, tag, title = '', fields = {}, body = '', rawBody }) {
  const raw = rawBody ?? body;
  const parsed = parseMessageParts(raw);
  if (parsed.tag) {
    if (MODERATOR_TAGS.includes(parsed.tag)) {
      throw new ProtocolError(`[${parsed.tag}] 是主導者專用標籤，agent 不能發`);
    }
    if (command !== 'post' && parsed.tag !== tag) {
      throw new UserError(`${command} 只發 [${tag}]，內文開頭的 [${parsed.tag}] 不符；請拿掉標籤列，或改用 agentchat post`);
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
  if (total > MAX_TOTAL_BYTES) {
    throw new UserError(`附檔總和超過 25 MB（${(total / MB).toFixed(1)} MB）`);
  }
  return files.map(({ abs }) => ({
    filename: path.basename(abs),
    data: fs.readFileSync(abs),
    contentType: contentTypeOf(abs),
  }));
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
    throw e;
  }
  return ids;
}

// 發言類指令的完整流程（§6.1、§6.2）。
// opts：command、tag、title、fields、body、rawBody、files、requireBody、transform(text)、mutate(state, ids)。
export async function publish(ctx, opts) {
  const room = ctx.room;
  const state = requireAgent(ctx);
  const body = opts.body ?? '';
  if (opts.requireBody && !(opts.rawBody ?? body)) {
    throw new UserError(`缺少內文：agentchat ${opts.command} --as ${state.name} <內文|->`);
  }

  const composed = composeText({ ...opts, body });
  let text = composed.text;
  const tag = composed.tag;

  // post --tag DISCUSS、或內文標籤是 DISCUSS，都照 discuss 的階段與輪數規則。
  const rules = new Set([opts.command, ...(tag === 'DISCUSS' ? ['discuss'] : [])]);
  for (const cmd of rules) {
    const problem = phaseError(state, cmd, room);
    if (problem) throw new ProtocolError(problem);
  }
  if (tag === 'DISCUSS') {
    const limit = roundLimit(state, room);
    if ((state.discussRound ?? 0) >= limit) {
      throw new ProtocolError(
        `本段討論已發 ${state.discussRound}/${limit} 則 [DISCUSS]，已達上限。請 agentchat wait --until moderator 等主導者 [CONTINUE] 或 [GO]。`,
      );
    }
  }
  if (opts.transform) text = opts.transform(text);

  const resolved = resolveMentions(text, room);
  const plan = planParts(resolved, text, room);
  const extraBytes = plan.extraFiles.reduce((n, f) => n + f.data.length, 0);
  const files = [...plan.extraFiles, ...loadFiles(opts.files, room, plan.extraFiles.length, extraBytes)];

  let ids;
  try {
    ids = await sendParts(ctx, state, plan.parts, files);
  } catch (e) {
    if (e.sentIds?.length) {
      updateAgent(room.channelId, state.name, (s) => {
        recordOwnMessages(s, e.sentIds);
      });
    }
    throw e;
  }

  const updated = updateAgent(room.channelId, state.name, (s) => {
    recordOwnMessages(s, ids);
    if (tag === 'DISCUSS') s.discussRound = (s.discussRound ?? 0) + 1;
    opts.mutate?.(s, ids);
  });
  appendLog(room.channelId, { dir: 'out', agent: state.name, tag, ids, content: resolved });

  let unread = null;
  let unreadError = null;
  try {
    unread = (await fetchUnread(ctx, updated, ids)).length;
  } catch (e) {
    unreadError = e.message;
  }
  return { state: updated, ids, tag, files: files.map((f) => f.filename), unread, unreadError };
}

// 發言類指令的共通輸出：訊息 ID、未讀、指令自己的補充、提醒。
export function publishResult(result, room, { lines = [], data = {} } = {}) {
  const { state, ids, tag, files, unread, unreadError } = result;
  const out = [`已送出 [${tag}]，訊息 ID：${ids[0]}${ids.length > 1 ? `（切成 ${ids.length} 則：${ids.join(', ')}）` : ''}`];
  if (files.length) out.push(`附檔：${files.join('、')}`);
  const u = unreadLine(unread ?? 0);
  if (u) out.push(u);
  if (unreadError) out.push(`未讀：無法取得（${unreadError}）`);
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
      unread,
      phase: phaseOf(state),
      reminders: rem,
      ...data,
    },
  };
}
