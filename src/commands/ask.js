import { waitText } from '../protocol.js';
import { BODY_OPTIONS, BODY_SOURCE_HELP, publish, publishResult, readBody } from '../publish.js';

export const summary = '發 [QUESTION] 向主導者提問，會真的 @ 主導者';
export const usage = 'agentchat ask --as <名稱> [--file <路徑>]... <問題|->';
export const options = { ...BODY_OPTIONS, file: { type: 'string', multiple: true } };
export const details = [
  BODY_SOURCE_HELP,'送出後記下待答問題；接著用 wait --until mention 等主導者回答（[ANSWER] 或回覆這則訊息）。'];

export async function run(ctx) {
  const room = ctx.room;
  const mention = `<@${room.moderatorUserId}>`;
  const body = await readBody(ctx);
  // §6.3：第一行是 `[QUESTION] <@主導者> <問題的第一行>`，其餘行是內文。
  const [firstLine, ...restLines] = body.split('\n');
  const result = await publish(ctx, {
    command: 'ask',
    tag: 'QUESTION',
    title: `${mention} ${firstLine.trim()}`.trim(),
    body: restLines.join('\n').trim(),
    rawBody: body,
    files: ctx.values.file,
    requireBody: true,
    // 內文自帶 [QUESTION] 標籤列時照原樣送，但第一行一定要有主導者 mention，否則不會通知。
    transform: (text) => {
      const [first, ...rest] = text.split('\n');
      if (first.includes(mention)) return text;
      return [first.replace(/^(\s*(?:\[[^\]]*\]|【[^】]*】|［[^］]*］))\s*/, `$1 ${mention} `).trimEnd(), ...rest].join('\n');
    },
    mutate: (s, ids) => {
      s.pendingQuestionId = ids[0];
    },
  });
  return publishResult(result, room, {
    lines: [`接著用 ${waitText(result.state.name, room, 'mention')} 等主導者回答`],
    data: { pendingQuestionId: result.ids[0] },
  });
}
