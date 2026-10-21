import { parse } from './args.js';
import { exitCodeOf, UserError, ProtocolError, DiscordError } from './errors.js';
import { isCommand, loadCommand, renderUsage } from './registry.js';
import { createContext } from './context.js';

// 指令名稱前面允許的全域旗標（不帶值的才能放在前面，帶值的 --as 等會和指令名稱混淆）。
const LEADING_FLAGS = new Set(['--json', '-h', '--help']);

// --json 要在解析參數之前就知道，參數錯誤時才能用 JSON 回報。`--` 之後是內文，不算。
function wantsJson(argv) {
  for (const a of argv) {
    if (a === '--') break;
    if (a === '--json') return true;
  }
  return false;
}

function write(stream, text) {
  if (text === undefined || text === null || text === '') return;
  stream.write(text.endsWith('\n') ? text : text + '\n');
}

function toText(text) {
  if (Array.isArray(text)) return text.filter((x) => x !== undefined && x !== null).join('\n');
  return text ?? '';
}

// 指令回傳 { text, data, code, error }：text 給 AI 讀，data 是 --json 的內容，
// code 非 0 時（例如 doctor 有 FAIL）error 是一句說明。
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const json = wantsJson(argv);
  try {
    // `agentchat --json post …`、`agentchat -h post` 這類把旗標放在指令前面的寫法也照常執行。
    let i = 0;
    while (i < argv.length && LEADING_FLAGS.has(argv[i])) i++;
    const leading = argv.slice(0, i);
    let name = argv[i];
    // 旗標放回參數最前面（不能放最後：`--` 之後的都算內文）。
    let rest = [...leading, ...argv.slice(i + 1)];
    if (name === undefined) {
      // 只有旗標（或什麼都沒給）：印總覽。
      name = 'help';
      rest = leading.filter((a) => a === '--json');
    }
    if (!isCommand(name)) {
      throw new UserError(`不認得的指令：${name}。用 agentchat help 看所有指令`);
    }
    const mod = await loadCommand(name);
    const { values, positionals } = parse(rest, mod.options || {});
    if (values.help && name !== 'help') {
      const usage = renderUsage(name, mod);
      if (json) write(stdout, JSON.stringify({ ok: true, command: name, usage }));
      else write(stdout, usage);
      return 0;
    }
    const ctx = createContext({ command: name, values, positionals, stdin: io.stdin ?? process.stdin });
    const result = (await mod.run(ctx)) || {};
    const code = result.code ?? 0;
    if (json) {
      const payload =
        code === 0
          ? { ok: true, ...(result.data || {}) }
          : { ok: false, error: { code, message: result.error || '失敗' }, ...(result.data || {}) };
      write(stdout, JSON.stringify(payload));
    } else {
      write(stdout, toText(result.text));
      if (code !== 0 && result.error) write(stderr, `agentchat: ${result.error}`);
    }
    return code;
  } catch (e) {
    const code = exitCodeOf(e);
    const known = e instanceof UserError || e instanceof ProtocolError || e instanceof DiscordError;
    const message = known ? e.message : `內部錯誤：${e?.message ?? e}`;
    if (json) write(stdout, JSON.stringify({ ok: false, error: { code, message } }));
    else write(stderr, `agentchat: ${message}`);
    if (!known && process.env.AGENTCHAT_DEBUG) write(stderr, e?.stack ?? String(e));
    return code;
  }
}
