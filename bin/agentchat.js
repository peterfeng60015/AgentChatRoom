#!/usr/bin/env node
// CLI 入口。經由 ~/.local/bin/agentchat 的 symlink 執行時，先解析成實際路徑再載入同一個 repo 的 src/，
// 這樣即使 Node 以 --preserve-symlinks-main 執行也找得到工具目錄。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const { main } = await import(pathToFileURL(path.join(here, '..', 'src', 'cli.js')).href);
const code = await main(process.argv.slice(2));
process.exitCode = code;
// 等 stdout、stderr 真的寫完（macOS 的 pipe 是非同步寫入），不會在讀的一方很慢時截斷輸出。
const flushed = (stream) => new Promise((resolve) => stream.write('', () => resolve()));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
// 正常情況讓 event loop 自然結束，不直接 process.exit()：Windows 上連續 fetch 之後馬上 exit，
// Node 會在 libuv 觸發 UV_HANDLE_CLOSING 斷言而崩潰（結束碼 3221226505）。
// 後備：若有連線池等 handle 讓行程掛著，1 秒後仍強制結束；unref 讓它本身不會拖住行程。
setTimeout(() => process.exit(code), 1000).unref();
