import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OWN_MESSAGE_KEEP } from './protocol.js';
import { UserError } from './errors.js';

// 每個 agent 的本機狀態（游標、角色、階段）都放這裡，不進 git。
export const STATE_DIR = path.resolve(process.env.AGENTCHAT_STATE_DIR || path.join(os.homedir(), '.agentchat'));

function agentFile(channelId, name) {
  return path.join(STATE_DIR, 'agents', String(channelId), `${name}.json`);
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

function readJson(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const state = loadAgent(channelId, name);
  if (!state) throw new UserError(`找不到 ${name} 的狀態檔，請先 agentchat join`);
  const result = mutate(state);
  saveAgent(state);
  return result === undefined ? state : result;
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

export function loadWebhook(channelId) {
  return readJson(webhookFile(channelId), 'webhook 快取');
}

export function saveWebhook(channelId, webhook) {
  writeAtomic(webhookFile(channelId), JSON.stringify(webhook, null, 2) + '\n', 0o600);
}

export function clearWebhook(channelId) {
  const file = webhookFile(channelId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function appendLog(channelId, entry) {
  const file = path.join(STATE_DIR, 'logs', `${channelId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function downloadDir(channelId, messageId) {
  return path.join(STATE_DIR, 'downloads', String(channelId), String(messageId));
}
