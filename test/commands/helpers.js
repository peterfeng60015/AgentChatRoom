// 指令層測試的共用環境：假 Discord + 暫存的工具目錄與狀態目錄，以子行程執行真正的 bin/agentchat.js。
// 子行程只拿到這裡組出的環境變數，不繼承外面的 DISCORD_BOT_TOKEN，也不碰真正的 ~/.agentchat。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDiscord } from './mock-discord.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = path.join(REPO, 'bin', 'agentchat.js');

export async function setup({ room = {}, mock = {}, sop = true } = {}) {
  const server = await startMockDiscord(mock);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-cmd-test-'));
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const userHome = path.join(root, 'user');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const roomConfig = {
    roomName: 'test-room',
    guildId: server.config.guildId,
    channelId: server.config.channelId,
    moderatorUserId: server.config.moderatorId,
    webhookName: 'agentchat',
    waitTimeoutSec: 2,
    pollIntervalSec: 0.05,
    ...room,
  };
  fs.writeFileSync(path.join(home, 'config', 'room.json'), JSON.stringify(roomConfig, null, 2));
  if (sop) {
    fs.mkdirSync(path.join(home, 'SOP'), { recursive: true });
    fs.writeFileSync(path.join(home, 'SOP', 'agent.md'), '# agent SOP\n測試用\n');
    fs.writeFileSync(path.join(home, 'SOP', 'moderator.md'), '# moderator SOP\n');
  }

  const baseEnv = {
    PATH: process.env.PATH,
    HOME: userHome,
    AGENTCHAT_HOME: home,
    AGENTCHAT_STATE_DIR: stateDir,
    AGENTCHAT_API_BASE: server.apiBase,
    DISCORD_BOT_TOKEN: server.config.token,
  };

  function run(args, { input = '', env = {}, stdin = 'pipe' } = {}) {
    return new Promise((resolve, reject) => {
      const childEnv = { ...baseEnv, ...env };
      for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
      const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, cwd: root, stdio: [stdin, 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code,
          stdout,
          stderr,
          json() {
            return JSON.parse(stdout);
          },
        });
      });
      if (stdin === 'pipe') child.stdin.end(input);
    });
  }

  const agentFile = (name) => path.join(stateDir, 'agents', server.config.channelId, `${name}.json`);

  return {
    mock: server,
    root,
    home,
    stateDir,
    room: roomConfig,
    run,
    agentFile,
    readState: (name) => JSON.parse(fs.readFileSync(agentFile(name), 'utf8')),
    writeState: (name, state) => fs.writeFileSync(agentFile(name), JSON.stringify(state, null, 2)),
    patchState(name, patch) {
      const s = JSON.parse(fs.readFileSync(agentFile(name), 'utf8'));
      Object.assign(s, patch);
      fs.writeFileSync(agentFile(name), JSON.stringify(s, null, 2));
      return s;
    },
    async join(name = 'claude-1', extra = []) {
      const r = await run(['join', '--as', name, '--vendor', 'claude', ...extra]);
      if (r.code !== 0) throw new Error(`join failed: ${r.code} ${r.stderr}`);
      return r;
    },
    async close() {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// 本房 webhook 發出的訊息（給斷言用）。
export function webhookMessages(mock) {
  return mock.messages.filter((m) => m.webhook_id);
}
