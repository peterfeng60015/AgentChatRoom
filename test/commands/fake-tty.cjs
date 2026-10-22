// clear 的確認流程測試用：用 NODE_OPTIONS --require 載入，讓子行程把 pipe 的 stdin 當成終端機。
Object.defineProperty(process.stdin, 'isTTY', { value: true });
