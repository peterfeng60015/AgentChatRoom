// src/render.js 的單元測試（SPEC §6.3 wait 的輸出、§7.5）。
// SPEC 沒規定確切版面，所以只驗必須出現的資訊：作者、角色、「提到你」、附檔名與大小、download 指令。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as render from '../../src/render.js';

const { renderMessage, renderMessages, fmtSize } = render;

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

  test('附檔：每個附檔一行，有檔名、大小與 agentchat download <id>', () => {
    const m = msg({
      attachments: [
        { id: 'a1', filename: 'design.png', size: 2048, url: 'https://cdn.example/design.png', contentType: 'image/png' },
        { id: 'a2', filename: 'notes.md', size: 300, url: 'https://cdn.example/notes.md', contentType: 'text/markdown' },
      ],
    });
    const lines = renderMessage(m).split('\n');
    for (const [name, size] of [['design.png', 2048], ['notes.md', 300]]) {
      const line = lines.find((l) => l.includes(name));
      assert.ok(line, `找不到 ${name} 的附檔行`);
      assert.ok(line.includes(fmtSize(size)), line);
      assert.ok(line.includes(`agentchat download ${m.id}`), line);
    }
  });

  test('附檔不顯示下載連結（只顯示檔名與大小，要用 download 才下載）', () => {
    const m = msg({ attachments: [{ id: 'a1', filename: 'x.zip', size: 10, url: 'https://cdn.example/secret-link/x.zip' }] });
    assert.ok(!renderMessage(m).includes('https://cdn.example/secret-link'));
  });

  test('只有附檔、沒有文字的訊息也顯示附檔行', () => {
    const m = msg({ content: '', tag: null, title: '', body: '', attachments: [{ id: 'a', filename: 'only.pdf', size: 5000 }] });
    const s = renderMessage(m);
    assert.ok(s.includes('only.pdf'));
    assert.ok(s.includes(`agentchat download ${m.id}`));
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

  test('空陣列', () => {
    assert.equal(renderMessages([]).trim(), '');
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

  test('KB', () => {
    assert.match(fmtSize(2048), /^2(\.0+)?\s*KB$/);
  });

  test('MB', () => {
    assert.match(fmtSize(5 * 1024 * 1024), /^5(\.0+)?\s*MB$/);
    assert.match(fmtSize(1.5 * 1024 * 1024), /^1\.5\s*MB$/);
  });
});
