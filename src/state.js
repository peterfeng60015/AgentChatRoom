import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 每個 agent 的本機狀態（游標、角色、階段）都放這裡，不進 git。
export const STATE_DIR = process.env.AGENTCHAT_STATE_DIR || path.join(os.homedir(), '.agentchat');

function agentFile(channelId, name) {
  return path.join(STATE_DIR, 'agents', channelId, `${name}.json`);
}

export function loadAgent(channelId, name) {
  const file = agentFile(channelId, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveAgent(state) {
  const file = agentFile(state.channelId, state.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return state;
}

export function newAgent({ name, vendor, channelId, cursor }) {
  const now = new Date().toISOString();
  return {
    name,
    vendor,
    channelId,
    role: null,
    branch: null,
    isolation: null,
    task: null,
    phase: 'lobby', // lobby → topic → discussion → work → done / stopped / closed / idle
    cursor,
    joinedAt: now,
    lastActivityAt: now,
    lastProgressAt: null,
    workStartedAt: null,
    discussRound: 0,
    discussLimit: null,
    topic: null,
    left: false,
  };
}

function webhookFile(channelId) {
  return path.join(STATE_DIR, 'webhooks', `${channelId}.json`);
}

export function loadWebhook(channelId) {
  const file = webhookFile(channelId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveWebhook(channelId, webhook) {
  const file = webhookFile(channelId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(webhook, null, 2) + '\n', { mode: 0o600 });
}

export function clearWebhook(channelId) {
  const file = webhookFile(channelId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function appendLog(channelId, entry) {
  const file = path.join(STATE_DIR, 'logs', `${channelId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function downloadDir(channelId, messageId) {
  return path.join(STATE_DIR, 'downloads', channelId, messageId);
}
