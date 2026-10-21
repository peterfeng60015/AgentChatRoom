// src/render.js 的單元測試（SPEC §6.3 wait 的輸出、§7.5）。
// §7.5 把 renderMessage 的格式寫死（SOP 依賴它），所以第一行、作者標示、「← 提到你」、附檔行、--- 分隔都逐字比對。
// fmtSize 的格式 SPEC 沒規定，只驗單位與數值；用 1024 進位，與附檔上限 maxFileMB 的換算一致。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as render from '../../src/render.js';

// fmtTime 印本地時間；固定成 UTC，讓預期值與執行機器的時區無關。
process.env.TZ = 'UTC';

const { renderMessage, renderMessages, fmtSize, fmtTime } = render;

// normalize() 的輸出形狀（SPEC §7.1）。
function msg(over = {}) {
  return {
    id: '1300000000000000123',
    timestamp: '2026-10-21T04:00:00.000Z',
    kind: 'agent',
    author: 'gemini-2',
    authorRole: '後端',
    authorId: '7000',
    content: '[DISCUSS] 看法\n\n我建議先拆 API。',
    tag: 'DISCUSS',
    title: '看法',
    fields: {},
    body: '我建議先拆 API。',
    mentionsMe: false,
    targetsMe: false,
    mentionsModerator: false,
    replyTo: null,
    attachments: [],
    ...over,
  };
}

describe('renderMessage', () => {
  test('agent：顯示名稱與角色、內容', () => {
    const s = renderMessage(msg());
    assert.ok(s.includes('gemini-2'));
    assert.ok(s.includes('後端'));
    assert.ok(s.includes('我建議先拆 API。'));
  });

  test('主導者標示為「主導者」', () => {
    const s = renderMessage(msg({ kind: 'moderator', author: 'Peter', authorRole: null, content: '[GO]', tag: 'GO' }));
    assert.ok(s.includes('主導者'));
    assert.ok(s.includes('Peter'));
  });

  test('不同作者身分的標示不同', () => {
    const base = { author: 'x', authorRole: null };
    const outputs = ['moderator', 'self', 'agent', 'bot', 'human'].map((kind) => renderMessage(msg({ ...base, kind })));
    assert.equal(new Set(outputs).size, outputs.length, outputs.join('\n---\n'));
  });

  test('提到我時標示「提到你」，沒提到時不標', () => {
    assert.ok(renderMessage(msg({ mentionsMe: true })).includes('提到你'));
    assert.ok(!renderMessage(msg({ mentionsMe: false })).includes('提到你'));
  });

  test('附檔：每個附檔一行，有檔名、大小與 agentchat download --as <as> <id>', () => {
    const m = msg({
      attachments: [
        { id: 'a1', filename: 'design.png', size: 2048, url: 'https://cdn.example/design.png', contentType: 'image/png' },
        { id: 'a2', filename: 'notes.md', size: 300, url: 'https://cdn.example/notes.md', contentType: 'text/markdown' },
      ],
    });
    const lines = renderMessage(m, { as: 'claude-1' }).split('\n');
    for (const [name, size] of [['design.png', 2048], ['notes.md', 300]]) {
      const line = lines.find((l) => l.includes(name));
      assert.ok(line, `找不到 ${name} 的附檔行`);
      assert.ok(line.includes(fmtSize(size)), line);
      assert.ok(line.includes(`agentchat download --as claude-1 ${m.id}`), line);
    }
  });

  test('沒有 as 時，download 指令寫成 --as <你的名稱>', () => {
    const m = msg({ attachments: [{ id: 'a1', filename: 'x.txt', size: 10 }] });
    for (const s of [renderMessage(m), renderMessage(m, {})]) {
      assert.ok(s.includes(`agentchat download --as <你的名稱> ${m.id}`), s);
    }
  });

  test('附檔不顯示下載連結（只顯示檔名與大小，要用 download 才下載）', () => {
    const m = msg({ attachments: [{ id: 'a1', filename: 'x.zip', size: 10, url: 'https://cdn.example/secret-link/x.zip' }] });
    assert.ok(!renderMessage(m).includes('https://cdn.example/secret-link'));
  });

  test('只有附檔、沒有文字的訊息也顯示附檔行', () => {
    const m = msg({ content: '', tag: null, title: '', body: '', attachments: [{ id: 'a', filename: 'only.pdf', size: 5000 }] });
    const s = renderMessage(m, { as: 'gemini-2' });
    assert.ok(s.includes('only.pdf'));
    assert.ok(s.includes(`agentchat download --as gemini-2 ${m.id}`));
  });
});

describe('renderMessages', () => {
  test('依序輸出每一則', () => {
    const a = msg({ id: '1', content: '第一則內容', body: '第一則內容' });
    const b = msg({ id: '2', kind: 'moderator', author: 'Peter', content: '第二則內容', body: '第二則內容' });
    const s = renderMessages([a, b]);
    assert.ok(s.includes(renderMessage(a)));
    assert.ok(s.includes(renderMessage(b)));
    assert.ok(s.indexOf('第一則內容') < s.indexOf('第二則內容'));
  });

  test('as 傳給每一則的附檔行', () => {
    const a = msg({ id: '11', attachments: [{ id: 'x', filename: 'a.png', size: 1 }] });
    const b = msg({ id: '12', attachments: [{ id: 'y', filename: 'b.png', size: 1 }] });
    const s = renderMessages([a, b], { as: 'codex-1' });
    assert.ok(s.includes('agentchat download --as codex-1 11'), s);
    assert.ok(s.includes('agentchat download --as codex-1 12'), s);
  });

  test('空陣列', () => {
    assert.equal(renderMessages([]).trim(), '');
  });
});

describe('renderMessage 的固定格式（§7.5，SOP 依賴它）', () => {
  const TS = '2026-10-21T04:05:06.000Z';
  const first = (over, opts) => renderMessage(msg({ timestamp: TS, ...over }), opts).split('\n')[0];

  test('fmtTime 是 MM/DD HH:MM:SS', () => {
    assert.equal(fmtTime(TS), '10/21 04:05:06');
  });

  test('第一行 [MM/DD HH:MM:SS] <作者標示>  (id=<訊息ID>)，接著是訊息原文', () => {
    const m = msg({ kind: 'moderator', author: 'Peter', authorRole: null, timestamp: TS, content: '[GO]\n\n開始執行' });
    const lines = renderMessage(m, { as: 'claude-1' }).split('\n');
    assert.equal(lines[0], `[10/21 04:05:06] 主導者 Peter  (id=${m.id})`);
    assert.deepEqual(lines.slice(1), ['[GO]', '', '開始執行']);
  });

  test('作者標示：主導者、agent（有角色加 (角色)）、你、人類、bot', () => {
    const id = msg().id;
    assert.equal(first({ kind: 'moderator', author: 'Peter', authorRole: null }), `[10/21 04:05:06] 主導者 Peter  (id=${id})`);
    assert.equal(first({ kind: 'agent', author: 'gemini-2', authorRole: '後端' }), `[10/21 04:05:06] agent gemini-2 (後端)  (id=${id})`);
    assert.equal(first({ kind: 'agent', author: 'gemini-2', authorRole: null }), `[10/21 04:05:06] agent gemini-2  (id=${id})`);
    assert.equal(first({ kind: 'self', author: 'claude-1', authorRole: null }), `[10/21 04:05:06] 你 claude-1  (id=${id})`);
    assert.equal(first({ kind: 'human', author: 'Guest', authorRole: null }), `[10/21 04:05:06] 人類 Guest  (id=${id})`);
    assert.equal(first({ kind: 'bot', author: 'GitHub', authorRole: null }), `[10/21 04:05:06] bot GitHub  (id=${id})`);
  });

  test('提到我或指令對我生效時，行尾加「  ← 提到你」', () => {
    const id = msg().id;
    const base = { kind: 'moderator', author: 'Peter', authorRole: null };
    const plain = `[10/21 04:05:06] 主導者 Peter  (id=${id})`;
    assert.equal(first({ ...base, mentionsMe: true }), `${plain}  ← 提到你`);
    assert.equal(first({ ...base, targetsMe: true }), `${plain}  ← 提到你`);
    assert.equal(first({ ...base, mentionsMe: true, targetsMe: true }), `${plain}  ← 提到你`);
    assert.equal(first(base), plain);
  });

  test('附檔行：附檔：<檔名>（<大小>）→ agentchat download --as <as> <訊息ID>', () => {
    const m = msg({ timestamp: TS, attachments: [{ id: 'a1', filename: 'design.png', size: 2048 }] });
    const lines = renderMessage(m, { as: 'claude-1' }).split('\n');
    assert.equal(lines.at(-1), `附檔：design.png（${fmtSize(2048)}）→ agentchat download --as claude-1 ${m.id}`);
    assert.equal(renderMessage(m).split('\n').at(-1), `附檔：design.png（${fmtSize(2048)}）→ agentchat download --as <你的名稱> ${m.id}`);
  });

  test('多則之間用一行 --- 分隔', () => {
    const a = msg({ id: '21', timestamp: TS, content: '第一則' });
    const b = msg({ id: '22', timestamp: TS, kind: 'moderator', author: 'Peter', authorRole: null, content: '第二則' });
    const opts = { as: 'claude-1' };
    assert.equal(renderMessages([a, b], opts), `${renderMessage(a, opts)}\n---\n${renderMessage(b, opts)}`);
  });
});

describe('kindLabel（§7.5 的作者標示）', () => {
  test('五種身分的標示', () => {
    assert.equal(render.kindLabel('moderator'), '主導者');
    assert.equal(render.kindLabel('agent'), 'agent');
    assert.equal(render.kindLabel('self'), '你');
    assert.equal(render.kindLabel('human'), '人類');
    assert.equal(render.kindLabel('bot'), 'bot');
  });
});

describe('section', () => {
  test('有標題與每一個項目', () => {
    const s = render.section('提醒', ['第一項', '第二項']);
    assert.ok(s.includes('提醒'));
    assert.ok(s.includes('第一項'));
    assert.ok(s.includes('第二項'));
    assert.ok(s.indexOf('第一項') < s.indexOf('第二項'));
  });
});

describe('fmtSize', () => {
  test('位元組', () => {
    assert.match(fmtSize(0), /^0\s*B$/);
    assert.match(fmtSize(500), /^500\s*B$/);
  });

  test('KB（1 KB = 1024 B）', () => {
    assert.match(fmtSize(2048), /^2(\.0+)?\s*KB$/);
    assert.match(fmtSize(500 * 1024), /^500(\.0+)?\s*KB$/);
  });

  test('MB', () => {
    assert.match(fmtSize(5 * 1024 * 1024), /^5(\.0+)?\s*MB$/);
    assert.match(fmtSize(1.5 * 1024 * 1024), /^1\.50*\s*MB$/);
  });
});
