import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OWN_MESSAGE_KEEP } from './protocol.js';
import { UserError } from './errors.js';

// 每個 agent 的本機狀態（游標、角色、階段）都放這裡，不進 git。
export const STATE_DIR = path.resolve(process.env.AGENTCHAT_STATE_DIR || path.join(os.homedir(), '.agentchat'));

// 名稱比對不分大小寫（§6.1），檔名一律用小寫；狀態裡仍保留原本的大小寫。
function agentFile(channelId, name) {
  return path.join(STATE_DIR, 'agents', String(channelId), `${String(name).toLowerCase()}.json`);
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 2000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 簡單的鎖檔：同一個 agent 的 wait 與發言指令可能同時讀改寫狀態檔，沒有鎖會互相蓋掉更新。
// 鎖只在同步的讀改寫期間持有（毫秒等級），超過 LOCK_STALE_MS 還在就是行程當掉留下的，直接清掉。
function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // 鎖剛好被放掉了，再試一次。
    }
    if (Date.now() - start > LOCK_WAIT_MS) throw new UserError(`狀態檔被鎖住太久：${lock}`);
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function webhookFile(channelId) {
  return path.join(STATE_DIR, 'webhooks', `${channelId}.json`);
}

// 先寫暫存檔再改名：同一個 agent 的 wait 與發言指令可能同時跑，改名可以避免讀到寫一半的檔。
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: mode ?? 0o644 });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 暫存檔可能根本沒建出來。
    }
    throw e;
  }
}

// 不先 existsSync 再讀：另一個行程可能剛好在中間刪掉檔案。檔案不存在回 null。
function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new UserError(`${label}讀不到：${file}（${e.code || e.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UserError(`${label}損壞，無法解析：${file}（${e.message}）`);
  }
}

export function loadAgent(channelId, name) {
  return readJson(agentFile(channelId, name), 'agent 狀態檔');
}

export function saveAgent(state) {
  writeAtomic(agentFile(state.channelId, state.name), JSON.stringify(state, null, 2) + '\n');
  return state;
}

// 重新讀檔、修改、存回。發言與 wait 可能同時進行，改狀態前一律以檔案上的最新內容為準。
export function updateAgent(channelId, name, mutate) {
  return withLock(agentFile(channelId, name), () => {
    const state = loadAgent(channelId, name);
    if (!state) throw new UserError(`找不到 ${name} 的狀態檔，請先 agentchat join`);
    const result = mutate(state);
    saveAgent(state);
    return result === undefined ? state : result;
  });
}

export function recordOwnMessages(state, ids, now = new Date().toISOString()) {
  state.ownMessageIds = [...(state.ownMessageIds || []), ...ids].slice(-OWN_MESSAGE_KEEP);
  state.lastActivityAt = now;
  state.emptyWaitSince = null;
  return state;
}

export function newAgent({ name, vendor = null, model = null, channelId, cursor = null }) {
  const now = new Date().toISOString();
  return {
    version: 1,
    name,
    vendor,
    model,
    channelId,
    role: null,
    task: null,
    branch: null,
    isolation: null,
    files: null,
    assigned: false,
    assignMessageId: null,
    assignBody: null,
    phaseBeforeStop: null,
    topic: null,
    phase: 'lobby',
    cursor,
    discussRound: 0,
    discussLimit: null,
    ownMessageIds: [],
    pendingQuestionId: null,
    joinedAt: now,
    lastActivityAt: now,
    lastProgressAt: null,
    workStartedAt: null,
    emptyWaitSince: null,
    left: false,
  };
}

// 快取壞掉時當作沒有快取（ensureWebhook 會重新取得並覆寫）；錯誤訊息會附原文片段，可能帶出 token，所以不往外丟。
export function loadWebhook(channelId) {
  try {
    return readJson(webhookFile(channelId), 'webhook 快取');
  } catch {
    return null;
  }
}

export function saveWebhook(channelId, webhook) {
  writeAtomic(webhookFile(channelId), JSON.stringify(webhook, null, 2) + '\n', 0o600);
}

export function clearWebhook(channelId) {
  // 兩個行程可能同時清，用 force 避免另一個先刪掉時丟 ENOENT。
  fs.rmSync(webhookFile(channelId), { force: true });
}

export function appendLog(channelId, entry) {
  const file = path.join(STATE_DIR, 'logs', `${channelId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function downloadDir(channelId, messageId) {
  return path.join(STATE_DIR, 'downloads', String(channelId), String(messageId));
}
