import { UserError } from '../errors.js';
import { FIELD_KEYS, parseMessageParts } from '../protocol.js';
import { requireAgent } from '../context.js';
import { BODY_OPTIONS, BODY_SOURCE_HELP, checkPostTag, publish, publishResult, readBody } from '../publish.js';

export const summary = '發一般訊息 [INFO]（或 --tag DISCUSS），可帶標題、欄位與附檔';
export const usage =
  'agentchat post --as <名稱> [--tag <TAG>] [--title <文字>] [--field key=value]... [--file <路徑>]... [內文|-]';
export const options = {
  ...BODY_OPTIONS,
  tag: { type: 'string' },
  title: { type: 'string' },
  field: { type: 'string', multiple: true },
  file: { type: 'string', multiple: true },
};
export const details = [
  BODY_SOURCE_HELP,
  '--tag 只接受 INFO 與 DISCUSS；--tag DISCUSS 等同 discuss，遵守同樣的階段與輪數規則。其他標籤請用 ask、progress、done 等對應指令。',
  `--field 的 key 只能是：${FIELD_KEYS.join('、')}。`,
  '內文已經以 [INFO] 或 [DISCUSS] 標籤列開頭時照原樣送出。',
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
  // 先確認身分：沒給 --as 或還沒 join 是結束碼 2，不該被標籤檢查搶先變成 3。
  const state = requireAgent(ctx);
  const tag = (ctx.values.tag ?? 'INFO').trim().toUpperCase();
  checkPostTag(tag, state.name, ctx.room);
  const fields = parseFields(ctx.values.field);
  const title = ctx.values.title !== undefined ? oneLine(ctx.values.title) : '';
  const body = await readBody(ctx);
  // 內文自帶標籤列時照原樣送，--tag／--title／--field 不會生效；與其默默丟掉，不如請 agent 二選一。
  const own = parseMessageParts(body).tag;
  // 內文是主導者標籤或 post 不收的標籤時，先照標籤規則回 3／2，再談選項衝突。
  if (own) checkPostTag(own, state.name, ctx.room);
  if (own && (ctx.values.title !== undefined || Object.keys(fields).length || (ctx.values.tag !== undefined && own !== tag))) {
    throw new UserError(`內文已經以 [${own}] 標籤列開頭，不能再給 --tag（不同標籤）、--title 或 --field；請擇一`);
  }
  if (!body && !title && !Object.keys(fields).length && !(ctx.values.file ?? []).length) {
    throw new UserError('沒有內容：請給內文、--title、--field 或 --file');
  }
  const result = await publish(ctx, { command: 'post', tag, title, fields, body, files: ctx.values.file });
  return publishResult(result, ctx.room);
}
