// src/args.js 與 src/errors.js 的單元測試（SPEC §6.1 共通選項、§7.5）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as args from '../../src/args.js';
import * as errors from '../../src/errors.js';

const { parse, requireAs, toInt } = args;
const { UserError, DiscordError } = errors;
const isUserError = (e) => e instanceof UserError;

describe('parse（§6.1 共通選項）', () => {
  test('沒有參數：json、help 不成立，沒有位置參數', () => {
    const r = parse([]);
    assert.ok(!r.values.json);
    assert.ok(!r.values.help);
    assert.deepEqual(r.positionals, []);
  });

  test('--as、--room、--json 與位置參數', () => {
    const r = parse(['--as', 'claude-1', '--room', 'lab', '--json', '你好', '世界']);
    assert.equal(r.values.as, 'claude-1');
    assert.equal(r.values.room, 'lab');
    assert.equal(r.values.json, true);
    assert.deepEqual(r.positionals, ['你好', '世界']);
  });

  test('-h 與 --help', () => {
    assert.equal(parse(['-h']).values.help, true);
    assert.equal(parse(['--help']).values.help, true);
  });

  test('指令自己的選項，含可重複的選項', () => {
    const r = parse(['--timeout', '5', '--file', 'a.png', '--file', 'b.md'], {
      timeout: { type: 'string' },
      file: { type: 'string', multiple: true },
    });
    assert.equal(r.values.timeout, '5');
    assert.deepEqual(r.values.file, ['a.png', 'b.md']);
  });

  test('位置參數 - 保留（代表讀 stdin）', () => {
    assert.deepEqual(parse(['--as', 'claude-1', '-']).positionals, ['-']);
  });

  test('不認得的選項丟 UserError', () => {
    assert.throws(() => parse(['--nope']), isUserError);
  });

  test('選項缺值丟 UserError', () => {
    assert.throws(() => parse(['--as']), isUserError);
  });
});

describe('requireAs', () => {
  test('有 --as 時回傳名稱', () => {
    assert.equal(requireAs({ as: 'claude-1' }), 'claude-1');
  });

  test('沒有 --as 丟 UserError', () => {
    assert.throws(() => requireAs({}), isUserError);
    assert.throws(() => requireAs({ as: '' }), isUserError);
  });
});

describe('toInt', () => {
  test('沒給值時回 fallback', () => {
    assert.equal(toInt(undefined, 90, '--timeout'), 90);
  });

  test('非負整數字串', () => {
    assert.equal(toInt('5', 90, '--timeout'), 5);
    assert.equal(toInt('0', 90, '--timeout'), 0);
    assert.equal(toInt('540', 90, '--timeout'), 540);
  });

  test('負數或非數字丟 UserError，訊息提到選項名稱', () => {
    for (const bad of ['-1', 'abc', '']) {
      assert.throws(
        () => toInt(bad, 90, '--timeout'),
        (e) => isUserError(e) && e.message.includes('--timeout'),
        JSON.stringify(bad),
      );
    }
  });
});

describe('UserError、DiscordError', () => {
  test('UserError 是 Error，帶訊息', () => {
    const e = new UserError('設定錯誤');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'UserError');
    assert.equal(e.message, '設定錯誤');
  });

  test('DiscordError 帶 HTTP 狀態、回應內容與提示', () => {
    const data = { message: 'Unknown Channel', code: 10003 };
    const e = new DiscordError(404, data, '找不到頻道');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'DiscordError');
    assert.equal(e.status, 404);
    assert.deepEqual(e.data, data);
    assert.ok(e.message.includes('找不到頻道'));
  });
});
