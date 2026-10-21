import { parseArgs } from 'node:util';
import { UserError } from './errors.js';

export const BASE_OPTIONS = {
  as: { type: 'string' },
  room: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

// parseArgs 的錯誤訊息是英文，常見的幾種換成中文，其餘保留原文。
function translate(e) {
  const unknown = e.message.match(/Unknown option '([^']+)'/);
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && unknown) {
    return `不認得的選項 ${unknown[1]}（內文若以 - 開頭，請放在 -- 之後，或改用 stdin）`;
  }
  const missing = e.message.match(/Option '([^']+)' argument missing/);
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && missing) {
    return `選項 ${missing[1].split(',').pop().trim()} 需要一個值`;
  }
  return e.message;
}

export function parse(argv, options = {}) {
  try {
    return parseArgs({ args: argv, options: { ...BASE_OPTIONS, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError(`參數錯誤：${translate(e)}`);
  }
}

export function requireAs(values) {
  if (!values.as) throw new UserError('缺少 --as <你的名稱>，例如 --as claude-1');
  return values.as;
}

export function toInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new UserError(`${label} 必須是非負整數`);
  return parseInt(text, 10);
}
