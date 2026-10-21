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
// 等 stdout、stderr 真的寫完（macOS 的 pipe 是非同步寫入）再結束，免得 fetch 的連線池讓行程多掛幾秒，
// 也不會在讀的一方很慢時截斷輸出。
const flushed = (stream) => new Promise((resolve) => stream.write('', () => resolve()));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
