import { parseArgs } from 'node:util';
import { UserError } from './errors.js';

const BASE_OPTIONS = {
  as: { type: 'string' },
  room: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

export function parse(argv, options = {}) {
  try {
    return parseArgs({ args: argv, options: { ...BASE_OPTIONS, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError(`參數錯誤：${e.message}`);
  }
}

export function requireAs(values) {
  if (!values.as) throw new UserError('缺少 --as <你的名稱>，例如 --as claude-1');
  return values.as;
}

export function toInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new UserError(`${label} 必須是非負整數`);
  return n;
}
