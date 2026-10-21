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
// fetch 的連線池或 stdin 偶爾會讓行程多掛幾秒；輸出寫完後就結束，計時器 unref 不會拖住正常結束。
setTimeout(() => process.exit(code), 3000).unref();
