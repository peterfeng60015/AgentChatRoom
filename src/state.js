import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OWN_MESSAGE_KEEP } from './protocol.js';
import { fmtTime } from './render.js';
import { ProtocolError, UserError } from './errors.js';

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
// 鎖只在同步的讀改寫期間持有（毫秒等級），超過 LOCK_STALE_MS 還在就是行程當掉留下的。
// 鎖檔內容是這次的識別碼，釋放時只刪自己的；清殘留鎖在 .break 短鎖裡進行，
// 免得兩個行程同時清殘留時一個刪掉另一個剛建好的鎖。
function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let seen;
    try {
      seen = { text: fs.readFileSync(lock, 'utf8'), age: Date.now() - fs.statSync(lock).mtimeMs };
    } catch {
      continue; // 鎖剛好被放掉了，再試一次。
    }
    if (seen.age > LOCK_STALE_MS) {
      // 清殘留鎖要先拿到 .break 短鎖，在裡面重新確認還是舊的才刪；新建的鎖 mtime 是新的，不會被誤刪。
      const breaker = `${lock}.break`;
      try {
        fs.writeFileSync(breaker, token, { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(breaker).mtimeMs > LOCK_STALE_MS) fs.rmSync(breaker, { force: true });
        } catch {
          // 已經被清掉。
        }
        sleepSync(2);
        continue;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // 鎖已經不在。
      } finally {
        fs.rmSync(breaker, { force: true });
      }
      continue;
    }
    if (Date.now() - start > LOCK_WAIT_MS) throw new UserError(`狀態檔被鎖住太久：${lock}`);
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true });
    } catch {
      // 鎖已經不在。
    }
  }
}

// 超過這個時間的 wait 鎖一定是殘留的（wait 最長 540 秒），避免 pid 被別的行程重用時誤判成還在跑。
const WAIT_LOCK_MAX_AGE_MS = 15 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// §6.3：同一個名稱同時只能有一個 wait。鎖檔內容是 pid；pid 已不在（或鎖太舊）就視為殘留，直接接手。
// 建鎖用「暫存檔寫好 pid 再 link」：link 是原子的，鎖檔一出現就有內容，別人不會讀到空檔誤判成殘留。
// 接手殘留鎖時在短鎖裡重讀確認，免得兩個行程都判定殘留、後者刪掉前者剛建好的新鎖。
// 回傳釋放鎖的函式。
export function acquireWaitLock(channelId, name) {
  const lock = agentFile(channelId, name).replace(/\.json$/, '.wait.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const read = () => {
    try {
      return { pid: Number(fs.readFileSync(lock, 'utf8').trim()), age: Date.now() - fs.statSync(lock).mtimeMs };
    } catch {
      return null; // 鎖剛好被放掉了
    }
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, String(process.pid));
    try {
      fs.linkSync(tmp, lock);
      return () => {
        const cur = read();
        if (cur && cur.pid === process.pid) fs.rmSync(lock, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const seen = read();
    if (!seen) continue;
    if (pidAlive(seen.pid) && seen.age < WAIT_LOCK_MAX_AGE_MS) {
      throw new ProtocolError(`同名已有另一個 wait 在執行（pid ${seen.pid}，${fmtTime(Date.now() - seen.age)} 開始），先讀完它的輸出`);
    }
    withLock(lock, () => {
      const again = read();
      if (again && again.pid === seen.pid && (!pidAlive(again.pid) || again.age >= WAIT_LOCK_MAX_AGE_MS)) {
        fs.rmSync(lock, { force: true });
      }
    });
  }
  throw new ProtocolError('同名已有另一個 wait 在執行，先讀完它的輸出');
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

// §6.3 clear 第 6 步的清除標記：clear 清掉狀態後為每個 agent 留一個，狀態檔不存在時用來分辨「被主導者清掉」與「還沒 join」。
function clearedFile(channelId, name) {
  return path.join(STATE_DIR, 'agents', String(channelId), `${String(name).toLowerCase()}.cleared`);
}

export function markCleared(channelId, names, now = new Date().toISOString()) {
  fs.mkdirSync(path.join(STATE_DIR, 'agents', String(channelId)), { recursive: true, mode: 0o700 });
  for (const name of names) {
    fs.writeFileSync(clearedFile(channelId, name), JSON.stringify({ name, clearedAt: now }) + '\n', { mode: 0o600 });
  }
}

export function unmarkCleared(channelId, name) {
  fs.rmSync(clearedFile(channelId, name), { force: true });
}

export function wasCleared(channelId, name) {
  return fs.existsSync(clearedFile(channelId, name));
}

export function clearedText(name) {
  return `${name} 的本機狀態已被主導者用 agentchat clear 清除：先停下來告訴使用者，不要自己重新 join`;
}

// 狀態檔不存在時的錯誤：有清除標記就叫 agent 停下來，不要自己重新 join；沒有就用呼叫端給的訊息。
export function missingAgentError(channelId, name, message) {
  return new UserError(wasCleared(channelId, name) ? clearedText(name) : message);
}

// 重新讀檔、修改、存回。發言與 wait 可能同時進行，改狀態前一律以檔案上的最新內容為準。
export function updateAgent(channelId, name, mutate) {
  return withLock(agentFile(channelId, name), () => {
    const state = loadAgent(channelId, name);
    if (!state) throw missingAgentError(channelId, name, `找不到 ${name} 的狀態檔，請先重新 join`);
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
    lastNotes: [],
    lastNotesAt: null,
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

// §3.3 agent 專屬 webhook 的快取：webhooks/<channelId>/<名稱小寫>.json，權限 0600。壞掉時當作沒有快取（避免錯誤訊息帶出 token）。
function agentWebhookDir(channelId) {
  return path.join(STATE_DIR, 'webhooks', String(channelId));
}

function agentWebhookFile(channelId, name) {
  return path.join(agentWebhookDir(channelId), `${String(name).toLowerCase()}.json`);
}

export function loadAgentWebhook(channelId, name) {
  try {
    const hook = readJson(agentWebhookFile(channelId, name), '專屬 webhook 快取');
    return typeof hook?.id === 'string' && typeof hook?.token === 'string' && hook.id && hook.token ? hook : null;
  } catch {
    return null;
  }
}

export function saveAgentWebhook(channelId, name, webhook) {
  writeAtomic(agentWebhookFile(channelId, name), JSON.stringify(webhook, null, 2) + '\n', 0o600);
}

export function clearAgentWebhook(channelId, name) {
  fs.rmSync(agentWebhookFile(channelId, name), { force: true });
}

// 本機所有專屬 webhook 快取（辨識本房 webhook 用，§4.5）。
export function listAgentWebhooks(channelId) {
  let names = [];
  try {
    names = fs.readdirSync(agentWebhookDir(channelId)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => loadAgentWebhook(channelId, n.slice(0, -'.json'.length))).filter(Boolean);
}

export function clearAgentWebhooks(channelId) {
  fs.rmSync(agentWebhookDir(channelId), { recursive: true, force: true, maxRetries: 3 });
}

// §4.5 辨識快取：{ room: [ID...], other: [ID...] }，不含 token。壞掉或不存在時回空的。
function knownFile(channelId) {
  return path.join(STATE_DIR, 'webhooks', `${channelId}.known.json`);
}

export function loadKnownWebhooks(channelId) {
  let data = null;
  try {
    data = readJson(knownFile(channelId), 'webhook 辨識快取');
  } catch {
    // 壞掉就重查。
  }
  const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  return { room: ids(data?.room), other: ids(data?.other) };
}

export function saveKnownWebhooks(channelId, known) {
  writeAtomic(knownFile(channelId), JSON.stringify({ room: [...new Set(known.room)], other: [...new Set(known.other)] }, null, 2) + '\n', 0o600);
}

export function clearKnownWebhooks(channelId) {
  fs.rmSync(knownFile(channelId), { force: true });
}

export function appendLog(channelId, entry) {
  const file = path.join(STATE_DIR, 'logs', `${channelId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function downloadDir(channelId, messageId) {
  return path.join(STATE_DIR, 'downloads', String(channelId), String(messageId));
}
