// 讓 npm test（node --test test/）一起跑 scripts/install.sh 的情境測試。
// 情境本身寫在 run.sh：安裝腳本是 bash，用 bash 驗證最直接；這裡只負責執行並在失敗時印出完整輸出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('scripts/install.sh 情境測試（暫存 HOME）', { skip: process.platform === 'win32' && '安裝腳本只支援 macOS 與 Linux' }, () => {
  const result = spawnSync('bash', [path.join(here, 'run.sh')], { encoding: 'utf8', timeout: 120_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.error, undefined, `無法執行 run.sh：${result.error?.message}\n${output}`);
  assert.equal(result.status, 0, `run.sh 結束碼 ${result.status}，輸出：\n${output}`);
});
