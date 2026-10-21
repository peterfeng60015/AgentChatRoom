import { ProtocolError, UserError } from '../errors.js';
import { ALL_TAGS, FIELD_KEYS, MODERATOR_TAGS } from '../protocol.js';
import { publish, publishResult, readBody } from '../publish.js';

export const summary = '發一般訊息（預設 [INFO]），可帶標題、欄位與附檔';
export const usage =
  'agentchat post --as <名稱> [--tag <TAG>] [--title <文字>] [--field key=value]... [--file <路徑>]... [內文|-]';
export const options = {
  tag: { type: 'string' },
  title: { type: 'string' },
  field: { type: 'string', multiple: true },
  file: { type: 'string', multiple: true },
};
export const details = [
  '--tag DISCUSS 等同 discuss，遵守同樣的階段與輪數規則；--tag 不能是主導者專用標籤。',
  `--field 的 key 只能是：${FIELD_KEYS.join('、')}。`,
  '內文來源：位置參數；`-` 或沒有位置參數且 stdin 不是終端機時讀 stdin。內文已經以標籤列開頭時照原樣送出。',
  '@moderator、@主導者 會換成真正的 mention；超過 2000 字自動切段，超過 longTextChars 改成附檔 message.md。',
];

const oneLine = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();

function parseFields(list = []) {
  const fields = {};
  for (const item of list) {
    const i = item.indexOf('=');
    if (i <= 0) throw new UserError(`--field 格式是 key=value：${item}`);
    const key = item.slice(0, i).trim().toLowerCase();
    if (!FIELD_KEYS.includes(key)) throw new UserError(`--field 的 key 只能是 ${FIELD_KEYS.join('、')}：${key}`);
    fields[key] = oneLine(item.slice(i + 1));
  }
  return fields;
}

export async function run(ctx) {
  const tag = (ctx.values.tag ?? 'INFO').trim().toUpperCase();
  if (MODERATOR_TAGS.includes(tag)) throw new ProtocolError(`[${tag}] 是主導者專用標籤，agent 不能發`);
  if (!ALL_TAGS.includes(tag)) throw new UserError(`不認得的標籤 ${tag}；agent 可用：JOIN、LEAVE、ACK、DISCUSS、QUESTION、PROGRESS、DONE、IDLE、INFO`);
  const fields = parseFields(ctx.values.field);
  const title = ctx.values.title !== undefined ? oneLine(ctx.values.title) : '';
  const body = await readBody(ctx);
  if (!body && !title && !Object.keys(fields).length && !(ctx.values.file ?? []).length) {
    throw new UserError('沒有內容：請給內文、--title、--field 或 --file');
  }
  const result = await publish(ctx, { command: 'post', tag, title, fields, body, files: ctx.values.file });
  return publishResult(result, ctx.room);
}
