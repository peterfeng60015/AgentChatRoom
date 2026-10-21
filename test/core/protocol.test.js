// src/protocol.js 的單元測試。預期值一律依 docs/SPEC.md（§4 訊息協定、§5 狀態與階段、§7.1 API），
// 不是依現有程式的行為；SPEC 沒規定的細節（提醒文字、欄位值型別等）只驗語意，不寫死格式。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// 用 namespace import：src 少了某個 export 時只有用到它的測試失敗，不會整檔無法載入。
import * as protocol from '../../src/protocol.js';

const {
  MODERATOR_TAGS,
  AGENT_TAGS,
  ALL_TAGS,
  FIELD_KEYS,
  NAME_RE,
  DISCORD_MESSAGE_LIMIT,
  validateAgentName,
  parseMessage,
  buildMessage,
  extractMentions,
  mentionsWord,
  isMentioned,
  targetsOf,
  isTargeted,
  resolveMentions,
  displayName,
  splitAgentName,
  isSelfName,
  sanitizeRole,
  authorKind,
  normalize,
  splitMessage,
  applyDirectives,
  reminders,
} = protocol;

// ---- 共用的假資料 ----

const MOD_ID = '816128017460887562';
const CHANNEL_ID = '1562304076115611710';
const WEBHOOK_ID = '7000000000000000001';
const OTHER_WEBHOOK_ID = '7000000000000000002';

const ROOM = {
  roomName: 'default',
  guildId: '1550401210861756457',
  channelId: CHANNEL_ID,
  moderatorUserId: MOD_ID,
  webhookName: 'agentchat',
  language: 'zh-TW',
  defaultRepo: null,
  defaultBase: 'main',
  maxDiscussionRounds: 3,
  waitTimeoutSec: 90,
  pollIntervalSec: 3,
  idleLimitMin: 60,
  progressReminderMin: 15,
  maxFileMB: 10,
  longTextChars: 6000,
};

const ISO = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-21T04:00:00.000Z');
let seq = 1_300_000_000_000_000_000n;
function nextId() {
  seq += 1n;
  return String(seq);
}

// Discord 原始訊息（GET /channels/{id}/messages 的單筆）。
function rawBase(content, author, extra = {}) {
  const id = nextId();
  return {
    id,
    type: 0,
    channel_id: CHANNEL_ID,
    timestamp: ISO(T0 + Number(seq % 100000n) * 1000),
    content,
    author,
    mentions: [],
    attachments: [],
    ...extra,
  };
}
const modRaw = (content, extra) =>
  rawBase(content, { id: MOD_ID, username: 'peter', global_name: 'Peter' }, extra);
// Discord 對 webhook 訊息的 author 會帶 bot: true，id 是 webhook ID，username 是當次的顯示名稱。
const agentRaw = (username, content, extra) =>
  rawBase(content, { id: WEBHOOK_ID, username, bot: true }, { webhook_id: WEBHOOK_ID, ...extra });
const otherWebhookRaw = (content, extra) =>
  rawBase(content, { id: OTHER_WEBHOOK_ID, username: 'GitHub', bot: true }, { webhook_id: OTHER_WEBHOOK_ID, ...extra });
const botRaw = (content, extra) => rawBase(content, { id: '8100', username: 'somebot', bot: true }, extra);
const humanRaw = (content, extra) => rawBase(content, { id: '8000', username: 'guest', global_name: 'Guest' }, extra);
// Discord 的「回覆」：type 19，message_reference 指向被回覆的訊息。
const replyTo = (messageId) => ({ type: 19, message_reference: { message_id: messageId, channel_id: CHANNEL_ID } });

const OWN_A = '1200000000000000001';
const OWN_B = '1200000000000000002';

// §5.1 的完整狀態；self 傳整個狀態物件（有 name、role、ownMessageIds）。
function makeState(over = {}) {
  return {
    version: 1,
    name: 'claude-1',
    vendor: 'claude',
    model: 'opus',
    channelId: CHANNEL_ID,
    role: null,
    task: null,
    branch: null,
    isolation: null,
    files: null,
    assigned: false,
    assignMessageId: null,
    assignBody: null,
    phaseBeforeStop: null,
    topic: null,
    phase: 'lobby',
    cursor: '1100000000000000000',
    discussRound: 0,
    discussLimit: null,
    ownMessageIds: [OWN_A, OWN_B],
    pendingQuestionId: null,
    joinedAt: ISO(T0 - 3600_000),
    lastActivityAt: ISO(T0 - 3600_000),
    lastProgressAt: null,
    workStartedAt: null,
    emptyWaitSince: null,
    left: false,
    ...over,
  };
}

// §7.1：opts 只帶 webhookId；「回覆我的訊息」由 normalize 從 self.ownMessageIds 判斷。
const norm = (raw, self) => normalize(raw, ROOM, self, { webhookId: WEBHOOK_ID });

// wait 的流程：先用套用前的狀態 normalize 全部累積的訊息，再依序 applyDirectives。
function apply(state, raws) {
  const messages = raws.map((r) => norm(r, state));
  return applyDirectives(state, messages, ROOM);
}

const sorted = (a) => [...a].sort();

// ---- §4.2、§4.3 清單與常數 ----

describe('標籤與欄位清單（§4.2、§4.3）', () => {
  test('MODERATOR_TAGS 是 §4.2 的七個主導者標籤', () => {
    assert.deepEqual(sorted(MODERATOR_TAGS), sorted(['TOPIC', 'ASSIGN', 'GO', 'CONTINUE', 'STOP', 'CLOSE', 'ANSWER']));
  });

  test('AGENT_TAGS 是 §4.2 的九個 agent 標籤', () => {
    assert.deepEqual(
      sorted(AGENT_TAGS),
      sorted(['JOIN', 'LEAVE', 'ACK', 'DISCUSS', 'QUESTION', 'PROGRESS', 'DONE', 'IDLE', 'INFO']),
    );
  });

  test('ALL_TAGS 是兩者的聯集', () => {
    assert.deepEqual(sorted(ALL_TAGS), sorted([...MODERATOR_TAGS, ...AGENT_TAGS]));
  });

  test('FIELD_KEYS 是 §4.3 的十六個欄位名稱', () => {
    assert.deepEqual(
      sorted(FIELD_KEYS),
      sorted([
        'repo', 'base', 'rounds', 'role', 'task', 'branch', 'isolation', 'files',
        'percent', 'eta', 'vendor', 'model', 'host', 'worktree', 'commit', 'to',
      ]),
    );
  });

  test('DISCORD_MESSAGE_LIMIT 是 2000', () => {
    assert.equal(DISCORD_MESSAGE_LIMIT, 2000);
  });
});

// ---- §6.1 名稱規則 ----

describe('validateAgentName / NAME_RE（§6.1 名稱規則）', () => {
  const valid = ['claude-1', 'gemini_2', 'a', '1abc', 'A-b_C', 'x'.repeat(31)];
  const invalid = [
    '', 'x'.repeat(32), '-abc', '_abc', 'claude 1', 'claude.1', '前端', 'claude-1!', 'a/b',
    'my-discord-bot', 'discord', 'clyde-1', 'xclydex',
  ];

  for (const name of valid) {
    test(`合法：${JSON.stringify(name)} 回 null`, () => {
      assert.equal(validateAgentName(name), null);
    });
  }

  for (const name of invalid) {
    test(`不合法：${JSON.stringify(name)} 回中文錯誤說明`, () => {
      const err = validateAgentName(name);
      assert.equal(typeof err, 'string');
      assert.match(err, /[一-鿿]/);
    });
  }

  test('null 與 undefined 也回錯誤說明', () => {
    assert.equal(typeof validateAgentName(null), 'string');
    assert.equal(typeof validateAgentName(undefined), 'string');
  });

  test('NAME_RE 符合字元與長度規則', () => {
    assert.ok(NAME_RE.test('claude-1'));
    assert.ok(NAME_RE.test('x'.repeat(31)));
    assert.ok(!NAME_RE.test('x'.repeat(32)));
    assert.ok(!NAME_RE.test('-x'));
    assert.ok(!NAME_RE.test(''));
  });
});

// ---- §4.1 parseMessage ----

describe('parseMessage（§4.1）', () => {
  test('半形標籤、標題、欄位、內文', () => {
    const r = parseMessage('[TOPIC] 登入流程重構\nrepo: /Users/me/app\nbase: develop\n\n先討論範圍。\n第二行。');
    assert.deepEqual(r, {
      tag: 'TOPIC',
      title: '登入流程重構',
      fields: { repo: '/Users/me/app', base: 'develop' },
      body: '先討論範圍。\n第二行。',
    });
  });

  test('全形括號【TAG】與［TAG］', () => {
    assert.equal(parseMessage('【TOPIC】 議題').tag, 'TOPIC');
    assert.equal(parseMessage('【TOPIC】 議題').title, '議題');
    assert.equal(parseMessage('［GO］').tag, 'GO');
    assert.equal(parseMessage('［GO］').title, '');
  });

  test('TAG 不分大小寫，結果一律大寫', () => {
    assert.equal(parseMessage('[assign] @claude-1').tag, 'ASSIGN');
    assert.equal(parseMessage('[Go]').tag, 'GO');
    assert.equal(parseMessage('【continue】 2').tag, 'CONTINUE');
  });

  test('每個 §4.2 標籤都認得', () => {
    for (const tag of ALL_TAGS) {
      assert.equal(parseMessage(`[${tag}] t`).tag, tag);
    }
  });

  test('沒有標題時 title 是空字串', () => {
    const r = parseMessage('[GO]');
    assert.equal(r.tag, 'GO');
    assert.equal(r.title, '');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, '');
  });

  test('標題裡可以有方括號', () => {
    assert.equal(parseMessage('[TOPIC] 討論 [草案] 內容').title, '討論 [草案] 內容');
  });

  test('不認得的標籤：整則視為內文，fields 為空', () => {
    const content = '[FOO] 標題\nrepo: /x\n\n內文';
    assert.deepEqual(parseMessage(content), { tag: null, title: '', fields: {}, body: content });
  });

  test('Markdown 連結開頭不是標籤', () => {
    const content = '[看這裡](https://example.com)';
    assert.deepEqual(parseMessage(content), { tag: null, title: '', fields: {}, body: content });
  });

  test('沒有標籤：即使開頭像欄位也不解析欄位', () => {
    const content = 'repo: /x\nbase: main\n內文';
    assert.deepEqual(parseMessage(content), { tag: null, title: '', fields: {}, body: content });
  });

  test('沒有標籤時內文去掉前後空白', () => {
    assert.deepEqual(parseMessage('  \n大家好\n  '), { tag: null, title: '', fields: {}, body: '大家好' });
  });

  test('空字串', () => {
    assert.deepEqual(parseMessage(''), { tag: null, title: '', fields: {}, body: '' });
  });

  test('全形冒號的欄位', () => {
    const r = parseMessage('[ASSIGN] @claude-1\nrole： 前端\ntask： 寫登入頁');
    assert.deepEqual(r.fields, { role: '前端', task: '寫登入頁' });
  });

  test('冒號前後可以沒有空白', () => {
    const r = parseMessage('[TOPIC] t\nrepo：/path\nbase:main\nrounds:2\n\n內文');
    assert.deepEqual(r.fields, { repo: '/path', base: 'main', rounds: '2' });
    assert.equal(r.body, '內文');
  });

  test('欄位值可以是空字串', () => {
    const r = parseMessage('[ACK]\nbranch:\nrole: 前端\n\n理解');
    assert.deepEqual(r.fields, { branch: '', role: '前端' });
    assert.equal(r.body, '理解');
  });

  test('欄位 key 不分大小寫，存成小寫', () => {
    const r = parseMessage('[ASSIGN] @claude-1\nRole: 前端\nBRANCH: feat/login');
    assert.deepEqual(r.fields, { role: '前端', branch: 'feat/login' });
  });

  test('值裡的冒號保留（只以第一個冒號分隔）', () => {
    const r = parseMessage('[TOPIC] t\nrepo: https://github.com/a/b.git');
    assert.equal(r.fields.repo, 'https://github.com/a/b.git');
  });

  test('§4.3 每個欄位名稱都認得', () => {
    for (const key of FIELD_KEYS) {
      const r = parseMessage(`[INFO] t\n${key}: v-${key}\n\nbody`);
      assert.deepEqual(r.fields, { [key]: `v-${key}` }, key);
      assert.equal(r.body, 'body');
    }
  });

  test('欄位名稱不限標籤（只認 §4.3 清單）', () => {
    assert.deepEqual(parseMessage('[INFO] t\nbranch: feat/x').fields, { branch: 'feat/x' });
  });

  test('遇到不認得的欄位就停止解析，之後全是內文', () => {
    const r = parseMessage('[TOPIC] t\nrepo: /a\nfoo: b\nbase: c\n\n內文');
    assert.deepEqual(r.fields, { repo: '/a' });
    assert.equal(r.body, 'foo: b\nbase: c\n\n內文');
  });

  test('中文 key 的「欄位」不是欄位', () => {
    const r = parseMessage('[DISCUSS] 看法\n我覺得: 可以\nrole: x');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, '我覺得: 可以\nrole: x');
  });

  test('空白行停止解析欄位，空白行之後的 key: value 屬於內文', () => {
    const r = parseMessage('[ASSIGN] @claude-1\nrole: 前端\n\ntask: 寫登入頁');
    assert.deepEqual(r.fields, { role: '前端' });
    assert.equal(r.body, 'task: 寫登入頁');
  });

  test('標籤只看第一行：第二行之後的 [TAG] 不是標籤', () => {
    for (const content of ['說明一下\n[GO]', '補充\n[TOPIC] 新題', '\n[STOP]']) {
      assert.deepEqual(parseMessage(content), { tag: null, title: '', fields: {}, body: content.trim() }, content);
    }
  });

  test('欄位只能緊接在標籤列之後：內文之後的 key: value 不算', () => {
    const r = parseMessage('[INFO] t\n內文\nrepo: /x');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, '內文\nrepo: /x');
  });

  test('內文前後空白去掉，中間保留', () => {
    const r = parseMessage('[DISCUSS] t\n\n\n  第一行\n\n  第二行  \n\n');
    assert.equal(r.body, '第一行\n\n  第二行');
  });

  test('標籤列之後直接接內文（沒有欄位、沒有空行）', () => {
    const r = parseMessage('[INFO] 標題\n內文');
    assert.deepEqual(r, { tag: 'INFO', title: '標題', fields: {}, body: '內文' });
  });
});

// ---- buildMessage ----

describe('buildMessage（§4.1 格式）', () => {
  test('組出 §4.1 格式，略過空值欄位', () => {
    const s = buildMessage('PROGRESS', '50%', { percent: '50', eta: null, branch: 'feat/x', commit: '', host: undefined }, '完成登入頁');
    assert.equal(s, '[PROGRESS] 50%\npercent: 50\nbranch: feat/x\n\n完成登入頁');
  });

  test('數值 0 不是空值，要保留（progress --percent 0）', () => {
    assert.equal(buildMessage('PROGRESS', '0%', { percent: 0, eta: '', branch: null }, '開始'), '[PROGRESS] 0%\npercent: 0\n\n開始');
  });

  test('沒有欄位時標籤列與內文之間空一行', () => {
    assert.equal(buildMessage('DISCUSS', '看法', {}, '我同意'), '[DISCUSS] 看法\n\n我同意');
  });

  const cases = [
    ['TOPIC', '議題', { repo: '/x', base: 'main', rounds: '2' }, '說明\n第二行'],
    ['ASSIGN', '@claude-1', { role: '前端', task: '寫 UI', branch: 'feat/ui', isolation: 'worktree' }, ''],
    ['JOIN', 'claude-1', { vendor: 'claude', model: 'opus' }, ''],
    ['DONE', '', { branch: 'b', worktree: '/w', commit: 'abc1234' }, '摘要'],
    ['INFO', '', {}, ''],
    ['QUESTION', '', {}, '<@1> 這樣可以嗎？'],
  ];
  for (const [tag, title, fields, body] of cases) {
    test(`來回一致：${tag}`, () => {
      assert.deepEqual(parseMessage(buildMessage(tag, title, fields, body)), { tag, title, fields, body });
    });
  }

  test('來回一致時空值欄位消失', () => {
    const r = parseMessage(buildMessage('ACK', '', { role: '前端', branch: null }, '理解'));
    assert.deepEqual(r.fields, { role: '前端' });
  });
});

// ---- §4.4 extractMentions ----

describe('extractMentions（§4.4 @ 位置、§7.1）', () => {
  const words = (content) => extractMentions(content).at.map((i) => content.slice(i));

  test('<@id> 放進 users，而且不是 @ 位置', () => {
    const r = extractMentions(`<@${MOD_ID}> 請看`);
    assert.deepEqual(r.users, [MOD_ID]);
    assert.deepEqual(r.at, []);
    assert.deepEqual(extractMentions('<@1> 和 <@22>').users, ['1', '22']);
  });

  test('at 是每個 @ 位置之後的文字索引', () => {
    const content = '@claude-1 請看，也請 ＠前端 看';
    const r = extractMentions(content);
    assert.equal(r.at.length, 2);
    assert.ok(content.slice(r.at[0]).startsWith('claude-1'));
    assert.ok(content.slice(r.at[1]).startsWith('前端'));
  });

  test('行首、空白、換行、標點、中文之後都是 @ 位置', () => {
    for (const s of ['@claude-1', '請 @claude-1', '第一行\n@claude-1', '（@claude-1）', '好，@claude-1', '「@claude-1」', '請@claude-1看', '麻煩＠claude-1']) {
      assert.equal(words(s).length, 1, s);
      assert.ok(words(s)[0].startsWith('claude-1'), s);
    }
  });

  test('email 帳號字元（英數字、_、.、+、-）緊接在 @ 前面不是 @ 位置', () => {
    for (const s of ['peter@example.com', 'a@claude-1', '1@claude-1', 'x_@claude-1', 'x.@claude-1', 'x+@claude-1', 'x-@claude-1', 'Z@前端 看']) {
      assert.deepEqual(extractMentions(s).at, [], s);
    }
  });

  test('@ 後面要緊接非空白字元', () => {
    assert.deepEqual(extractMentions('@ 你好').at, []);
    assert.deepEqual(extractMentions('結尾是 @').at, []);
    assert.deepEqual(extractMentions('@\nclaude-1').at, []);
  });

  test('沒有 mention', () => {
    assert.deepEqual(extractMentions('大家好'), { users: [], at: [] });
  });
});

// ---- §4.4 mentionsWord ----

describe('mentionsWord（§4.4「@ 到 W」）', () => {
  const yes = (text, word) => assert.equal(mentionsWord(text, word), true, `${text} 應該 @ 到 ${word}`);
  const no = (text, word) => assert.equal(mentionsWord(text, word), false, `${text} 不應該 @ 到 ${word}`);

  test('W 以英數字結尾：下一字不是英數字、_、- 才算', () => {
    yes('@claude-1 請看', 'claude-1');
    yes('@claude-1請看', 'claude-1');
    yes('@claude-1，請看', 'claude-1');
    yes('@claude-1.', 'claude-1');
    yes('@claude-1', 'claude-1');
    no('@claude-10', 'claude-1');
    no('@claude-1_x', 'claude-1');
    no('@claude-1-x', 'claude-1');
    no('@claude', 'claude-1');
  });

  test('不分大小寫', () => {
    yes('@Claude-1 看', 'claude-1');
    yes('@claude-1 看', 'CLAUDE-1');
    yes('@qa工程師', 'QA');
  });

  test('W 以中文結尾：下一字要是空白、- 與 _ 以外的標點或符號，或結尾', () => {
    yes('@前端 請看', '前端');
    yes('@前端，請看', '前端');
    yes('@前端」', '前端');
    yes('@前端!', '前端');
    yes('@前端+後端', '前端');
    yes('請 @前端', '前端');
    no('@前端請看', '前端');
    no('@前端-主', '前端');
    no('@前端_主', '前端');
  });

  test('含 - 或中英混合的角色都 @ 得到', () => {
    yes('@前端-主，請看', '前端-主');
    yes('@前端-主 請看', '前端-主');
    no('@前端-主任', '前端-主');
    yes('@UI設計 請看', 'UI設計');
    yes('@ui設計，請看', 'UI設計');
    no('@UI設計師', 'UI設計');
    yes('@QA-前端 看', 'QA-前端');
    yes('@QA-Lead 看', 'qa-lead');
    no('@QA-Leader', 'qa-lead');
  });

  test('廣播詞也用同一套規則', () => {
    yes('@here有人嗎', 'here');
    yes('@全體 注意', '全體');
    no('@全體成員', '全體');
    no('@allx', 'all');
  });

  test('只在 @ 位置比對：email、沒有 @、<@ID> 都不算', () => {
    no('a@claude-1', 'claude-1');
    no('x.@前端 看', '前端');
    no('claude-1 請看', 'claude-1');
    no('<@123456789012345678>', '123456789012345678');
    no('@ claude-1', 'claude-1');
  });

  test('多個 @ 位置裡任一個符合就算', () => {
    yes('@claude-2 @claude-1', 'claude-1');
    yes('@claude-10 與 ＠claude-1，請看', 'claude-1');
    no('@claude-10 與 @claude-11', 'claude-1');
  });
});

// ---- §4.4 isMentioned ----

describe('isMentioned（§4.4「提到我」的文字部分）', () => {
  const self = { name: 'claude-1', role: '前端' };

  test('@ 我的名稱，不分大小寫，也接受全形 ＠', () => {
    assert.equal(isMentioned('@claude-1 請看', self), true);
    assert.equal(isMentioned('@CLAUDE-1 請看', self), true);
    assert.equal(isMentioned('＠claude-1 請看', self), true);
  });

  test('名稱前後緊接中文也算', () => {
    assert.equal(isMentioned('請@claude-1看', self), true);
    assert.equal(isMentioned('@claude-1請看', self), true);
  });

  test('mention 在內文任何一行都算', () => {
    assert.equal(isMentioned('[DISCUSS] 看法\n\n第一行\n第二行 @claude-1', self), true);
  });

  test('@ 我的中文角色', () => {
    assert.equal(isMentioned('@前端 請看', self), true);
    assert.equal(isMentioned('麻煩＠前端，看一下', self), true);
  });

  test('中文角色後面直接接中文、或接 - 與 _：不算', () => {
    assert.equal(isMentioned('@前端請看', self), false);
    assert.equal(isMentioned('@前端-主 請看', self), false);
  });

  test('各種角色都 @ 得到', () => {
    for (const [role, text] of [
      ['qa', '@qa工程師 看一下'],
      ['qa', '@QA 看一下'],
      ['UI設計', '@UI設計 請看'],
      ['前端-主', '@前端-主，請看'],
      ['QA-前端', '@qa-前端 請看'],
      ['前端_主', '@前端_主 請看'],
    ]) {
      assert.equal(isMentioned(text, { name: 'claude-1', role }), true, `${role}：${text}`);
    }
  });

  for (const word of ['all', 'agents', 'everyone', 'here', '全體']) {
    test(`廣播 @${word}`, () => {
      assert.equal(isMentioned(`@${word} 注意`, self), true);
      assert.equal(isMentioned(`＠${word} 注意`, self), true);
    });
  }

  test('廣播字後面接中文也算（@here有人嗎）', () => {
    assert.equal(isMentioned('@here有人嗎', self), true);
  });

  test('@ 別人、名稱前綴相同的別人都不算', () => {
    assert.equal(isMentioned('@claude-2 請看', self), false);
    assert.equal(isMentioned('@claude-10 請看', self), false);
    assert.equal(isMentioned('@claude 請看', self), false);
    assert.equal(isMentioned('@後端 請看', self), false);
  });

  test('email 形式不算', () => {
    assert.equal(isMentioned('a@claude-1 b@前端 x.@claude-1', self), false);
  });

  test('沒有角色時，只看名稱與廣播', () => {
    const noRole = { name: 'claude-1', role: null };
    assert.equal(isMentioned('@前端 請看', noRole), false);
    assert.equal(isMentioned('@claude-1', noRole), true);
    assert.equal(isMentioned('@全體', noRole), true);
  });

  test('@moderator 不是提到 agent', () => {
    assert.equal(isMentioned('@moderator 請看', self), false);
  });
});

// ---- targetsOf ----

describe('targetsOf（只看第一行，回 { hasAt, broadcast }）', () => {
  test('第一行有 @ 位置', () => {
    assert.deepEqual(targetsOf('[GO] @Claude-1 @gemini-2'), { hasAt: true, broadcast: false });
    assert.deepEqual(targetsOf('[GO] 請＠前端開始'), { hasAt: true, broadcast: false });
  });

  test('第二行之後的 @ 不算', () => {
    assert.deepEqual(targetsOf('[GO]\n@claude-1 開始'), { hasAt: false, broadcast: false });
    assert.deepEqual(targetsOf('[GO]\n@全體'), { hasAt: false, broadcast: false });
  });

  test('第一行沒有 @、只有 <@ID>、只有 email：hasAt 為 false', () => {
    assert.deepEqual(targetsOf('[STOP] 先停'), { hasAt: false, broadcast: false });
    assert.deepEqual(targetsOf('[GO] <@123456789012345678>'), { hasAt: false, broadcast: false });
    assert.deepEqual(targetsOf('[GO] 寄到 a@b.com'), { hasAt: false, broadcast: false });
  });

  test('第一行 @ 到廣播詞', () => {
    for (const word of ['all', 'agents', 'everyone', 'here', '全體']) {
      assert.deepEqual(targetsOf(`[GO] @${word}`), { hasAt: true, broadcast: true }, word);
    }
    assert.deepEqual(targetsOf('[GO] ＠全體 開始'), { hasAt: true, broadcast: true });
    assert.deepEqual(targetsOf('[GO] @here有人嗎'), { hasAt: true, broadcast: true });
    assert.deepEqual(targetsOf('[GO] @allx'), { hasAt: true, broadcast: false });
  });
});

// ---- §4.4 isTargeted ----

describe('isTargeted（§4.4「指令對我生效」、§7.1）', () => {
  // 已被指派、在討論階段、角色是「前端」的 agent。
  const self = makeState({ role: '前端', assigned: true, phase: 'discussion' });
  const t = (raw, s = self) => isTargeted(norm(raw, s), s);

  test('TOPIC、CLOSE 一律生效，即使第一行 @ 別人', () => {
    assert.equal(t(modRaw('[TOPIC] 議題')), true);
    assert.equal(t(modRaw('[TOPIC] @claude-2 議題')), true);
    assert.equal(t(modRaw('[CLOSE]')), true);
    assert.equal(t(modRaw('[CLOSE] @claude-2')), true);
    assert.equal(t(modRaw('[TOPIC] 議題'), makeState({ phase: 'lobby' })), true);
  });

  test('ASSIGN：第一行 @ 我的名稱或廣播', () => {
    assert.equal(t(modRaw('[ASSIGN] @claude-1\nrole: 前端')), true);
    assert.equal(t(modRaw('[ASSIGN] ＠Claude-1\nrole: 前端')), true);
    assert.equal(t(modRaw('[ASSIGN] @全體\nrole: 評審')), true);
    assert.equal(t(modRaw('[ASSIGN] @all\nrole: 評審')), true);
    assert.equal(t(modRaw('[ASSIGN] @claude-2 @claude-1\nrole: 評審')), true);
  });

  test('ASSIGN：@ 別人、只 @ 我的角色、只在第二行之後 @ 我，都不生效', () => {
    assert.equal(t(modRaw('[ASSIGN] @claude-2\nrole: 後端')), false);
    assert.equal(t(modRaw('[ASSIGN] @前端\nrole: 前端')), false);
    assert.equal(t(modRaw('[ASSIGN] 分工\nrole: 前端\n\n@claude-1 負責這塊')), false);
  });

  test('ASSIGN：Discord 回覆我的訊息不算（只有 ANSWER 接受回覆）', () => {
    assert.equal(t(modRaw('[ASSIGN] 分工\nrole: 前端', replyTo(OWN_A))), false);
  });

  test('ANSWER：第一行 @ 我的名稱或廣播', () => {
    assert.equal(t(modRaw('[ANSWER] @claude-1\n\n可以')), true);
    assert.equal(t(modRaw('[ANSWER] @全體\n\n可以')), true);
    assert.equal(t(modRaw('[ANSWER] @claude-2\n\n可以')), false);
  });

  test('ANSWER：to: 我的名稱', () => {
    assert.equal(t(modRaw('[ANSWER]\nto: claude-1\n\n可以')), true);
    assert.equal(t(modRaw('[ANSWER]\nto: claude-2\n\n可以')), false);
    // 值可以帶開頭的 @／＠，比對不分大小寫。
    assert.equal(t(modRaw('[ANSWER]\nto: @claude-1\n\n可以')), true);
    assert.equal(t(modRaw('[ANSWER]\nto: ＠Claude-1\n\n可以')), true);
    assert.equal(t(modRaw('[ANSWER]\nto: CLAUDE-1\n\n可以')), true);
    assert.equal(t(modRaw('[ANSWER]\nto: @claude-2\n\n可以')), false);
  });

  test('ANSWER：Discord 回覆我的訊息', () => {
    assert.equal(t(modRaw('[ANSWER] 可以', replyTo(OWN_B))), true);
    assert.equal(t(modRaw('[ANSWER] 可以', replyTo('1299999999999999999'))), false);
  });

  for (const tag of ['GO', 'CONTINUE', 'STOP']) {
    test(`${tag}：第一行有 @ 就只對被 @ 的名稱、角色、廣播生效`, () => {
      assert.equal(t(modRaw(`[${tag}] @claude-1`)), true);
      assert.equal(t(modRaw(`[${tag}] @claude-2 @CLAUDE-1`)), true);
      assert.equal(t(modRaw(`[${tag}] @前端`)), true);
      assert.equal(t(modRaw(`[${tag}] @全體`)), true);
      assert.equal(t(modRaw(`[${tag}] @here`)), true);
      assert.equal(t(modRaw(`[${tag}] @claude-2`)), false);
      assert.equal(t(modRaw(`[${tag}] @後端`)), false);
    });

    test(`${tag}：第一行有 @ 時不看階段與是否被指派，left 除外`, () => {
      for (const phase of ['lobby', 'topic', 'discussion', 'work', 'done', 'stopped', 'closed', 'idle']) {
        assert.equal(t(modRaw(`[${tag}] @claude-1`), makeState({ assigned: false, phase })), true, phase);
      }
      const left = makeState({ assigned: true, phase: 'left', left: true });
      assert.equal(t(modRaw(`[${tag}] @claude-1`), left), false);
      assert.equal(t(modRaw(`[${tag}] @全體`), left), false);
    });
  }

  for (const tag of ['GO', 'CONTINUE']) {
    test(`${tag}：第一行沒有 @ 時，只對已被指派、且在 discussion（或 stopped 而停下前是 discussion／work）的 agent 生效`, () => {
      assert.equal(t(modRaw(`[${tag}]`), makeState({ assigned: true, phase: 'discussion' })), true);
      for (const before of ['discussion', 'work']) {
        const s = makeState({ assigned: true, phase: 'stopped', phaseBeforeStop: before });
        assert.equal(t(modRaw(`[${tag}]`), s), true, `stopped（停下前 ${before}）`);
      }
      // 停下前已經 done，或不知道停下前的階段：不受影響。
      for (const before of ['done', null]) {
        const s = makeState({ assigned: true, phase: 'stopped', phaseBeforeStop: before });
        assert.equal(t(modRaw(`[${tag}]`), s), false, `stopped（停下前 ${before}）`);
      }
      // 第二行之後的 @ 不算「第一行有 @」。
      assert.equal(t(modRaw(`[${tag}]\n\n@claude-2 你先`), makeState({ assigned: true, phase: 'discussion' })), true);
      // 沒被指派的 agent 不受影響。
      for (const phase of ['lobby', 'topic', 'stopped']) {
        assert.equal(t(modRaw(`[${tag}]`), makeState({ assigned: false, phase })), false, `未指派 ${phase}`);
      }
      // 已被指派，但階段不是 discussion 或 stopped。
      for (const phase of ['work', 'done', 'closed', 'idle']) {
        assert.equal(t(modRaw(`[${tag}]`), makeState({ assigned: true, phase })), false, `已指派 ${phase}`);
      }
      assert.equal(t(modRaw(`[${tag}]`), makeState({ assigned: true, phase: 'left', left: true })), false);
    });
  }

  test('STOP：第一行沒有 @ 時，對 closed、idle、left 以外的所有階段生效', () => {
    for (const phase of ['lobby', 'topic', 'discussion', 'work', 'done', 'stopped']) {
      assert.equal(t(modRaw('[STOP]'), makeState({ assigned: false, phase })), true, phase);
    }
    for (const phase of ['closed', 'idle']) {
      assert.equal(t(modRaw('[STOP]'), makeState({ assigned: true, phase })), false, phase);
    }
    assert.equal(t(modRaw('[STOP]'), makeState({ assigned: true, phase: 'left', left: true })), false);
  });

  test('GO 第一行 @ 角色：依「@ 到 W」的邊界比對', () => {
    for (const [role, line, want] of [
      ['UI設計', '[GO] @UI設計 開始', true],
      ['前端-主', '[GO] @前端-主，開始', true],
      ['前端', '[GO] @前端-主，開始', false],
      ['前端', '[GO] @前端請開始', false],
      ['qa', '[GO] @qa工程師開始', true],
    ]) {
      const s = makeState({ role, assigned: true, phase: 'discussion' });
      assert.equal(t(modRaw(line), s), want, `${role}：${line}`);
    }
  });

  test('第一行有 @ 但沒有 @ 到我：不生效（即使已被指派且在討論中）', () => {
    assert.equal(t(modRaw('[GO] @前端請開始')), false);
    assert.equal(t(modRaw('[CONTINUE] @claude-10')), false);
  });

  test('CONTINUE 的數字與 @ 同時出現', () => {
    assert.equal(t(modRaw('[CONTINUE] 2 @claude-1')), true);
    assert.equal(t(modRaw('[CONTINUE] 2 @claude-2')), false);
  });

  test('第一行只有 Discord 的 <@使用者ID>：不算「有 @」，照沒有 @ 的規則', () => {
    const uid = '<@123456789012345678>';
    assert.equal(t(modRaw(`[GO] ${uid}`), makeState({ assigned: true, phase: 'discussion' })), true);
    assert.equal(t(modRaw(`[GO] ${uid}`), makeState({ assigned: false, phase: 'topic' })), false);
    assert.equal(t(modRaw(`[CONTINUE] ${uid} 2`), makeState({ assigned: false, phase: 'topic' })), false);
    assert.equal(t(modRaw(`[STOP] ${uid}`), makeState({ assigned: false, phase: 'work' })), true);
    assert.equal(t(modRaw(`[STOP] ${uid}`), makeState({ assigned: false, phase: 'closed' })), false);
  });

  test('msg.kind 存在且不是 moderator：一律不生效', () => {
    for (const raw of [
      agentRaw('claude-2 (後端)', '[GO] @claude-1'),
      agentRaw('claude-2 (後端)', '[ASSIGN] @claude-1\nrole: 後端'),
      humanRaw('[TOPIC] 假議題'),
      botRaw('[CLOSE]'),
      otherWebhookRaw('[STOP]'),
    ]) {
      assert.equal(t(raw), false, raw.content);
    }
  });

  test('沒有 kind 的手工物件只看標籤與第一行', () => {
    const msg = (content) => ({ ...parseMessage(content), content });
    assert.equal(isTargeted(msg('[GO] @claude-1'), self), true);
    assert.equal(isTargeted(msg('[GO] @claude-2'), self), false);
    assert.equal(isTargeted(msg('[CLOSE]'), self), true);
    assert.equal(isTargeted(msg('[ASSIGN] @claude-1\nrole: x'), self), true);
    assert.equal(isTargeted(msg('[ASSIGN] @claude-2\nrole: x'), self), false);
  });
});

// ---- resolveMentions ----

describe('resolveMentions（§4.4 主導者 mention）', () => {
  const tag = `<@${MOD_ID}>`;

  test('@moderator 與 @主導者 換成 <@moderatorUserId>', () => {
    assert.equal(resolveMentions('請 @moderator 確認', ROOM), `請 ${tag} 確認`);
    assert.equal(resolveMentions('@主導者 這樣可以嗎', ROOM), `${tag} 這樣可以嗎`);
  });

  test('全形 ＠', () => {
    assert.equal(resolveMentions('＠moderator 看一下', ROOM), `${tag} 看一下`);
    assert.equal(resolveMentions('請 ＠主導者 決定', ROOM), `請 ${tag} 決定`);
  });

  test('出現多次全部換掉', () => {
    assert.equal(resolveMentions('@moderator 和 @主導者', ROOM), `${tag} 和 ${tag}`);
  });

  test('中文緊接在 @ 前面也換；後面不要求邊界（@主導者決定 也換）', () => {
    assert.equal(resolveMentions('請＠主導者 決定', ROOM), `請${tag} 決定`);
    assert.equal(resolveMentions('請@moderator確認', ROOM), `請${tag}確認`);
    assert.equal(resolveMentions('@主導者決定', ROOM), `${tag}決定`);
  });

  test('不是 @ 位置（email 形式、@ 後面是空白）不換', () => {
    assert.equal(resolveMentions('寄 a@moderator 或 x.@主導者', ROOM), '寄 a@moderator 或 x.@主導者');
    assert.equal(resolveMentions('@ moderator', ROOM), '@ moderator');
  });

  test('沒有主導者 mention 時原樣回傳，其他 @ 不動', () => {
    assert.equal(resolveMentions('@claude-2 你看', ROOM), '@claude-2 你看');
  });
});

// ---- displayName / splitAgentName / isSelfName / sanitizeRole ----

describe('displayName', () => {
  test('名稱 (角色)', () => {
    assert.equal(displayName('claude-1', '前端'), 'claude-1 (前端)');
  });

  test('沒有角色時只有名稱', () => {
    assert.equal(displayName('claude-1', null), 'claude-1');
    assert.equal(displayName('claude-1', ''), 'claude-1');
  });

  test('總長截到 80 字', () => {
    const s = displayName('claude-1', '很長的角色'.repeat(30));
    assert.ok(s.length <= 80, `長度 ${s.length}`);
    assert.ok(s.startsWith('claude-1 ('));
  });

  test('剛好 80 字不截', () => {
    const role = 'r'.repeat(80 - 'claude-1 ()'.length);
    assert.equal(displayName('claude-1', role), `claude-1 (${role})`);
  });

  test('與 splitAgentName 來回一致', () => {
    assert.deepEqual(splitAgentName(displayName('gemini-2', '後端 API')), { name: 'gemini-2', role: '後端 API' });
  });
});

describe('splitAgentName', () => {
  test('名稱 (角色)', () => {
    assert.deepEqual(splitAgentName('claude-1 (前端)'), { name: 'claude-1', role: '前端' });
  });

  test('只有名稱', () => {
    const r = splitAgentName('claude-1');
    assert.equal(r.name, 'claude-1');
    assert.equal(r.role ?? null, null);
  });
});

describe('isSelfName（§4.5 self 的名稱判斷）', () => {
  test('等於我的名稱，或以「我的名稱 (」開頭', () => {
    assert.equal(isSelfName('claude-1', 'claude-1'), true);
    assert.equal(isSelfName('claude-1 (前端)', 'claude-1'), true);
  });

  test('名稱比對不分大小寫（§6.1）', () => {
    assert.equal(isSelfName('CLAUDE-1', 'claude-1'), true);
    assert.equal(isSelfName('Claude-1 (前端)', 'claude-1'), true);
  });

  test('前綴相同的別人不算', () => {
    assert.equal(isSelfName('claude-10', 'claude-1'), false);
    assert.equal(isSelfName('claude-10 (前端)', 'claude-1'), false);
    assert.equal(isSelfName('claude-1-x', 'claude-1'), false);
    assert.equal(isSelfName('claude-2 (claude-1)', 'claude-1'), false);
  });
});

describe('sanitizeRole（§7.1）', () => {
  test('刪除（不是換成空白）半形與全形括號', () => {
    assert.equal(sanitizeRole('(前端)'), '前端');
    assert.equal(sanitizeRole('（前端）'), '前端');
    assert.equal(sanitizeRole('前端(主)'), '前端主');
    assert.equal(sanitizeRole('前端（主）'), '前端主');
  });

  test('刪除 @、＠、#、:、：、反引號', () => {
    assert.equal(sanitizeRole('@前端'), '前端');
    assert.equal(sanitizeRole('＠前端'), '前端');
    assert.equal(sanitizeRole('#qa'), 'qa');
    assert.equal(sanitizeRole('role:前端'), 'role前端');
    assert.equal(sanitizeRole('role：前端'), 'role前端');
    assert.equal(sanitizeRole('`dev`'), 'dev');
  });

  test('換行與連續空白換成一個 -，去掉頭尾的 -', () => {
    assert.equal(sanitizeRole('QA Lead'), 'QA-Lead');
    assert.equal(sanitizeRole('a    b'), 'a-b');
    assert.equal(sanitizeRole('前端 \n 後端'), '前端-後端');
    assert.equal(sanitizeRole('前端\r\n後端'), '前端-後端');
    assert.equal(sanitizeRole('  前端  '), '前端');
    assert.equal(sanitizeRole('前端 (主)'), '前端-主');
  });

  test('截到 40 字（先清理再截）', () => {
    assert.equal(sanitizeRole('x'.repeat(50)), 'x'.repeat(40));
    assert.equal(sanitizeRole('('.repeat(10) + 'y'.repeat(50)), 'y'.repeat(40));
  });

  test('空字串或清理後為空回 null', () => {
    for (const v of ['', null, undefined, '()（）', ' @ # : ` ', '   ', '\n']) {
      assert.equal(sanitizeRole(v), null, JSON.stringify(v));
    }
  });
});

// ---- §4.5 authorKind ----

describe('authorKind（§4.5）', () => {
  const self = makeState();
  const opts = { webhookId: WEBHOOK_ID };

  test('moderator：作者 ID 等於 moderatorUserId', () => {
    assert.equal(authorKind(modRaw('hi'), ROOM, self, opts), 'moderator');
  });

  test('self：本房 webhook，顯示名稱是我的名稱或以「我的名稱 (」開頭', () => {
    assert.equal(authorKind(agentRaw('claude-1', 'hi'), ROOM, self, opts), 'self');
    assert.equal(authorKind(agentRaw('claude-1 (前端)', 'hi'), ROOM, self, opts), 'self');
  });

  test('agent：本房 webhook 的其他名稱（含前綴相同的名稱）', () => {
    assert.equal(authorKind(agentRaw('claude-2 (後端)', 'hi'), ROOM, self, opts), 'agent');
    assert.equal(authorKind(agentRaw('claude-10', 'hi'), ROOM, self, opts), 'agent');
  });

  test('bot：其他 webhook，即使顯示名稱和我一樣', () => {
    assert.equal(authorKind(otherWebhookRaw('hi'), ROOM, self, opts), 'bot');
    const spoof = rawBase('hi', { id: OTHER_WEBHOOK_ID, username: 'claude-1', bot: true }, { webhook_id: OTHER_WEBHOOK_ID });
    assert.equal(authorKind(spoof, ROOM, self, opts), 'bot');
  });

  test('bot：bot 帳號', () => {
    assert.equal(authorKind(botRaw('hi'), ROOM, self, opts), 'bot');
  });

  test('human：其他人類', () => {
    assert.equal(authorKind(humanRaw('hi'), ROOM, self, opts), 'human');
  });

  test('不知道本房 webhook ID 時，webhook 訊息不歸為 bot：名稱是我的是 self，其餘是 agent', () => {
    assert.equal(authorKind(agentRaw('claude-1 (前端)', 'hi'), ROOM, self, {}), 'self');
    assert.equal(authorKind(agentRaw('claude-2', 'hi'), ROOM, self, {}), 'agent');
    assert.equal(authorKind(otherWebhookRaw('hi'), ROOM, self, {}), 'agent');
  });

  test('self 是 null 時沒有 self，本房 webhook 都是 agent', () => {
    assert.equal(authorKind(agentRaw('claude-1', 'hi'), ROOM, null, opts), 'agent');
    assert.equal(authorKind(modRaw('hi'), ROOM, null, opts), 'moderator');
    assert.equal(authorKind(humanRaw('hi'), ROOM, null, opts), 'human');
  });
});

// ---- §7.1 normalize ----

describe('normalize（§7.1）', () => {
  const self = makeState({ role: '前端', assigned: true, phase: 'discussion' });

  test('回傳 SPEC 列出的全部欄位', () => {
    const m = norm(modRaw('[TOPIC] 議題\nrepo: /x\n\n說明'), self);
    for (const key of [
      'id', 'timestamp', 'kind', 'author', 'authorRole', 'authorId', 'content', 'tag', 'title', 'fields',
      'body', 'mentionsMe', 'targetsMe', 'mentionsModerator', 'replyTo', 'attachments',
    ]) {
      assert.ok(Object.hasOwn(m, key), `缺少 ${key}`);
    }
  });

  test('id、timestamp、authorId、content 與解析結果', () => {
    const raw = modRaw('[TOPIC] 議題\nrepo: /x\n\n說明');
    const m = norm(raw, self);
    assert.equal(m.id, raw.id);
    assert.equal(m.timestamp, raw.timestamp);
    assert.equal(m.authorId, MOD_ID);
    assert.equal(m.content, raw.content);
    assert.equal(m.kind, 'moderator');
    assert.equal(m.tag, 'TOPIC');
    assert.equal(m.title, '議題');
    assert.deepEqual(m.fields, { repo: '/x' });
    assert.equal(m.body, '說明');
  });

  test('agent 訊息拆出名稱與角色', () => {
    const m = norm(agentRaw('gemini-2 (後端)', '[DISCUSS] 看法'), self);
    assert.equal(m.kind, 'agent');
    assert.equal(m.author, 'gemini-2');
    assert.equal(m.authorRole, '後端');
  });

  test('replyTo 取自 message_reference.message_id；沒有回覆時為空', () => {
    assert.equal(norm(modRaw('好', replyTo(OWN_A)), self).replyTo, OWN_A);
    assert.equal(norm(modRaw('好'), self).replyTo ?? null, null);
  });

  test('mentionsMe：內文 @ 我的名稱、角色或廣播', () => {
    assert.equal(norm(humanRaw('@claude-1 你好'), self).mentionsMe, true);
    assert.equal(norm(agentRaw('gemini-2', '[DISCUSS] t\n\n@前端 你看'), self).mentionsMe, true);
    assert.equal(norm(modRaw('@全體 注意'), self).mentionsMe, true);
    assert.equal(norm(modRaw('@claude-2 注意'), self).mentionsMe, false);
  });

  test('mentionsMe：Discord 回覆我發的訊息（ownMessageIds）', () => {
    assert.equal(norm(modRaw('好的', replyTo(OWN_A)), self).mentionsMe, true);
    assert.equal(norm(agentRaw('gemini-2', '同意', replyTo(OWN_B)), self).mentionsMe, true);
    assert.equal(norm(modRaw('好的', replyTo('1299999999999999999')), self).mentionsMe, false);
  });

  test('targetsMe 與 isTargeted 一致', () => {
    for (const content of ['[GO]', '[GO] @claude-2', '[GO] @前端', '[ASSIGN] @claude-1\nrole: x', '[ASSIGN] @claude-2', '[CLOSE]']) {
      const m = norm(modRaw(content), self);
      assert.equal(m.targetsMe, isTargeted(m, self), content);
    }
    assert.equal(norm(modRaw('[GO]'), self).targetsMe, true);
    assert.equal(norm(modRaw('[GO] @claude-2'), self).targetsMe, false);
    assert.equal(norm(modRaw('[ANSWER] 可以', replyTo(OWN_A)), self).targetsMe, true);
  });

  test('mentionsModerator：訊息有通知主導者', () => {
    const m = norm(agentRaw('claude-2', `[QUESTION]\n\n<@${MOD_ID}> 請問`, { mentions: [{ id: MOD_ID, username: 'peter' }] }), self);
    assert.equal(m.mentionsModerator, true);
    assert.equal(norm(agentRaw('claude-2', '[INFO] hi'), self).mentionsModerator, false);
  });

  test('attachments 帶檔名與大小；沒有附檔時是空陣列', () => {
    const raw = agentRaw('claude-2', '[INFO] 圖', {
      attachments: [{ id: '9', filename: 'shot.png', size: 2048, url: 'https://cdn.example/shot.png', content_type: 'image/png' }],
    });
    const m = norm(raw, self);
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].filename, 'shot.png');
    assert.equal(m.attachments[0].size, 2048);
    assert.deepEqual(norm(modRaw('hi'), self).attachments, []);
  });

  test('kind 依 §4.5 判斷（含 webhookId）', () => {
    assert.equal(norm(agentRaw('claude-1 (前端)', 'hi'), self).kind, 'self');
    assert.equal(norm(otherWebhookRaw('hi'), self).kind, 'bot');
    assert.equal(norm(humanRaw('hi'), self).kind, 'human');
  });

  test('mentionsMe：回覆我的待答問題，即使它已掉出 ownMessageIds', () => {
    const OLD_Q = '1100000000000000099';
    const s = makeState({ ownMessageIds: [OWN_A], pendingQuestionId: OLD_Q });
    assert.equal(norm(modRaw('可以', replyTo(OLD_Q)), s).mentionsMe, true);
  });

  test('主導者的純文字與 agent 標籤不是指令：targetsMe 為 false', () => {
    for (const content of ['大家好', '@claude-1 你好', '@全體 注意', '[INFO] @claude-1 開始', '[DISCUSS] t', '[DONE]', '[FOO] @claude-1', '說明\n[GO]']) {
      const m = norm(modRaw(content), self);
      assert.equal(m.targetsMe, false, content);
      assert.equal(isTargeted(m, self), false, content);
    }
  });

  test('targetsMe 只有主導者訊息可能為 true', () => {
    assert.equal(norm(agentRaw('claude-2', '[GO] @claude-1'), self).targetsMe, false);
    assert.equal(norm(humanRaw('[TOPIC] 假議題'), self).targetsMe, false);
    assert.equal(norm(otherWebhookRaw('[CLOSE]'), self).targetsMe, false);
  });

  test('self 可以是 null', () => {
    const m = normalize(agentRaw('claude-1', '@claude-1 hi'), ROOM, null, { webhookId: WEBHOOK_ID });
    assert.equal(m.kind, 'agent');
    assert.equal(m.mentionsMe, false);
  });
});

// ---- §7.1 splitMessage ----

describe('splitMessage（§7.1）', () => {
  const MARK = /\s*\((\d+)\/(\d+)\)$/;
  const strip = (chunk) => chunk.replace(MARK, '');
  // 每段各自從 fence 外開始逐行追蹤開關，把每個非空白字元標成在 fence 內（I）或外（O）。
  // 所有段串起來要等於原文同樣處理的結果，而且每段結尾都要回到 fence 外；
  // 去掉空白是因為切段處可能吃掉段落交界的空白。只數 ``` 是否偶數抓不到「下一段沒重開 fence」。
  function fenceTrace(text) {
    let inside = false;
    let out = '';
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) {
        inside = !inside;
        continue;
      }
      for (const ch of line.replace(/\s/g, '')) out += (inside ? 'I' : 'O') + ch;
    }
    return { out, closed: !inside };
  }
  function checkFences(chunks, text, where = '') {
    const bodies = chunks.length > 1 ? chunks.map(strip) : chunks;
    let got = '';
    bodies.forEach((b, i) => {
      const trace = fenceTrace(b);
      assert.ok(trace.closed, `${where}第 ${i + 1} 段結尾還在 code fence 裡`);
      got += trace.out;
    });
    assert.ok(got === fenceTrace(text).out, `${where}fence 內外的內容與原文不一致`);
  }

  function checkMarkers(chunks) {
    assert.ok(chunks.length > 1);
    chunks.forEach((c, i) => {
      const m = c.match(MARK);
      assert.ok(m, `第 ${i + 1} 段結尾沒有 (i/n)：${JSON.stringify(c.slice(-20))}`);
      assert.equal(Number(m[1]), i + 1);
      assert.equal(Number(m[2]), chunks.length);
    });
  }

  test('不超過上限時原樣回傳一段、不加標記', () => {
    assert.deepEqual(splitMessage('短訊息'), ['短訊息']);
    const exact = 'x'.repeat(2000);
    assert.deepEqual(splitMessage(exact), [exact]);
  });

  test('多行長文：每段 ≤ 2000、加 (i/n)、在行邊界切、內容不遺失', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `第 ${i} 行：${'內容'.repeat(5)}`);
    const text = lines.join('\n');
    const chunks = splitMessage(text);
    checkMarkers(chunks);
    for (const c of chunks) assert.ok(c.length <= 2000, `長度 ${c.length}`);
    const lineSet = new Set(lines);
    for (const c of chunks) {
      for (const l of strip(c).split('\n')) assert.ok(lineSet.has(l), `行被切斷：${l}`);
    }
    assert.equal(chunks.map(strip).join('\n'), text);
  });

  test('接受自訂 limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
    const chunks = splitMessage(text, 300);
    checkMarkers(chunks);
    for (const c of chunks) assert.ok(c.length <= 300, `長度 ${c.length}`);
    assert.equal(chunks.map(strip).join('\n'), text);
  });

  test('超長單行：硬切，每段 ≤ limit，內容不遺失', () => {
    const text = 'a'.repeat(5000);
    const chunks = splitMessage(text);
    checkMarkers(chunks);
    for (const c of chunks) assert.ok(c.length <= 2000, `長度 ${c.length}`);
    assert.equal(chunks.map(strip).join('').replace(/\s/g, ''), text);
  });

  test('每行都接近上限時，加上 (i/n) 仍不超過上限', () => {
    const lines = ['b'.repeat(1995), 'c'.repeat(1995), 'd'.repeat(1995)];
    const chunks = splitMessage(lines.join('\n'));
    checkMarkers(chunks);
    for (const c of chunks) assert.ok(c.length <= 2000, `長度 ${c.length}`);
    const joined = chunks.map(strip).join('');
    for (const ch of ['b', 'c', 'd']) assert.equal(joined.split(ch).length - 1, 1995, ch);
  });

  test('code fence 跨段時，每段的 ``` 都成對，程式碼行不遺失也不重複', () => {
    const code = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i}; // ${'z'.repeat(10)}`);
    const text = ['說明如下：', '```js', ...code, '```', '結尾'].join('\n');
    const chunks = splitMessage(text);
    checkMarkers(chunks);
    for (const c of chunks) assert.ok(c.length <= 2000, `長度 ${c.length}`);
    checkFences(chunks, text);
    const seen = chunks.flatMap((c) => strip(c).split('\n')).filter((l) => !/^\s*```/.test(l));
    assert.deepEqual(seen, ['說明如下：', ...code, '結尾']);
  });

  test('code fence 裡有超長單行，硬切後每段的 ``` 仍成對', () => {
    const text = ['```', 'q'.repeat(5000), '```'].join('\n');
    const chunks = splitMessage(text);
    checkMarkers(chunks);
    for (const c of chunks) assert.ok(c.length <= 2000, `長度 ${c.length}`);
    checkFences(chunks, text);
  });

  test('隨機輸入（固定種子）：每段 ≤ limit、標記正確、fence 兩邊成對、內容與 fence 內外不變', () => {
    let seed = 20261021;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    for (let t = 0; t < 400; t++) {
      const limit = pick([60, 100, 300, 2000]);
      const lines = [];
      let inFence = false;
      for (let i = 0, n = Math.floor(rnd() * 120); i < n; i++) {
        const r = rnd();
        if (r < 0.08) {
          lines.push(inFence ? '```' : pick(['```', '```js', '  ```py']));
          inFence = !inFence;
        } else if (r < 0.15) lines.push('');
        else if (r < 0.2) lines.push(pick(['x', '中']).repeat(Math.floor(rnd() * limit * 3)));
        else lines.push(pick(['a', 'b', '字']).repeat(1 + Math.floor(rnd() * limit * 0.6)));
      }
      if (inFence) lines.push('```');
      const text = lines.join('\n');
      const chunks = splitMessage(text, limit);
      const where = `第 ${t} 組（limit ${limit}，長度 ${text.length}）`;
      if (text.length <= limit) {
        assert.deepEqual(chunks, [text], where);
        continue;
      }
      if (chunks.length > 1) checkMarkers(chunks);
      chunks.forEach((c, i) => assert.ok(c.length <= limit, `${where} 第 ${i + 1} 段長度 ${c.length}`));
      checkFences(chunks, text, `${where} `);
    }
  });
});

// ---- §4.2、§5 applyDirectives ----

// 已被指派、在討論階段的 agent（第一行沒有 @ 的 [GO]、[CONTINUE] 只對這種 agent 生效）。
const assignedState = (over = {}) => makeState({ assigned: true, role: '前端', phase: 'discussion', ...over });

describe('applyDirectives：TOPIC（§4.2、§5.2）', () => {
  test('lobby 收到 TOPIC：設定議題、階段改為 topic', () => {
    const state = makeState();
    const raw = modRaw('[TOPIC] 登入重構\nrepo: /Users/me/app\nbase: develop\nrounds: 2\n\n範圍說明');
    const notes = apply(state, [raw]);
    assert.equal(state.phase, 'topic');
    assert.equal(state.topic.id, raw.id);
    assert.equal(state.topic.title, '登入重構');
    assert.deepEqual(state.topic.fields, { repo: '/Users/me/app', base: 'develop', rounds: '2' });
    assert.equal(state.topic.body, '範圍說明');
    assert.deepEqual(state.topic.attachments, []);
    assert.ok(Array.isArray(notes) && notes.length >= 1);
    for (const n of notes) assert.equal(typeof n, 'string');
  });

  test('TOPIC 記下議題訊息的附檔清單（檔名、大小）', () => {
    const state = makeState();
    apply(state, [
      modRaw('[TOPIC] 看設計稿', {
        attachments: [
          { id: '1', filename: 'design.png', size: 2048, url: 'https://cdn.example/d.png', content_type: 'image/png' },
          { id: '2', filename: 'spec.md', size: 300, url: 'https://cdn.example/s.md' },
        ],
      }),
    ]);
    const files = state.topic.attachments;
    assert.equal(files.length, 2);
    assert.equal(files[0].filename, 'design.png');
    assert.equal(files[0].size, 2048);
    assert.equal(files[1].filename, 'spec.md');
    assert.equal(files[1].size, 300);
  });

  test('TOPIC 清除分工、待答問題、進度時間，assigned 設回 false，討論計數與上限重置', () => {
    const state = assignedState({
      phase: 'work', task: '寫 UI', branch: 'feat/ui', isolation: 'shared', files: ['src/ui'],
      pendingQuestionId: OWN_B, lastProgressAt: ISO(T0 - 60_000), workStartedAt: ISO(T0 - 600_000),
      assignMessageId: '1290000000000000001', assignBody: '舊分工細節', phaseBeforeStop: 'work',
      discussRound: 2, discussLimit: 5,
      topic: { id: '1', title: '舊', fields: { rounds: '4' }, body: '' },
    });
    apply(state, [modRaw('[TOPIC] 新議題')]);
    assert.equal(state.phase, 'topic');
    assert.equal(state.topic.title, '新議題');
    for (const key of [
      'role', 'task', 'branch', 'isolation', 'files', 'assignMessageId', 'assignBody', 'phaseBeforeStop',
      'pendingQuestionId', 'lastProgressAt', 'workStartedAt', 'discussLimit',
    ]) {
      assert.equal(state[key], null, key);
    }
    assert.equal(state.assigned, false);
    assert.equal(state.discussRound, 0);
  });

  test('TOPIC 第一行 @ 別人也對我生效', () => {
    const state = makeState();
    apply(state, [modRaw('[TOPIC] @claude-2 議題')]);
    assert.equal(state.phase, 'topic');
  });

  test('TOPIC 從 closed、idle、done、stopped 也會開新議題', () => {
    for (const over of [{ phase: 'closed' }, { phase: 'idle' }, { phase: 'done' }, { phase: 'stopped', phaseBeforeStop: 'work' }]) {
      const state = assignedState(over);
      apply(state, [modRaw('[TOPIC] 下一題')]);
      assert.equal(state.phase, 'topic', over.phase);
      assert.equal(state.topic.title, '下一題', over.phase);
      assert.equal(state.phaseBeforeStop, null, over.phase);
    }
  });
});

describe('applyDirectives：ASSIGN', () => {
  test('對我生效：設定角色與分工、記下訊息 ID 與內文、assigned 為 true、階段 discussion、計數歸零、上限設回 null', () => {
    const state = makeState({ phase: 'topic', discussRound: 2, discussLimit: 5 });
    const raw = modRaw('[ASSIGN] @claude-1\nrole: 前端\ntask: 寫登入頁\nbranch: feat/login\nisolation: shared\nfiles: src/ui, src/css，docs/a.md\n\n細節第一行\n細節第二行');
    const notes = apply(state, [raw]);
    assert.equal(state.assignMessageId, raw.id);
    assert.equal(state.assignBody, '細節第一行\n細節第二行');
    assert.equal(state.discussLimit, null);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.assigned, true);
    assert.equal(state.role, '前端');
    assert.equal(state.task, '寫登入頁');
    assert.equal(state.branch, 'feat/login');
    assert.equal(state.isolation, 'shared');
    assert.equal(state.discussRound, 0);
    assert.ok(notes.length >= 1);
  });

  test('整組取代分工：沒寫的欄位清成 null（含 role）', () => {
    const state = assignedState({ phase: 'work', task: '舊分工', branch: 'feat/old', isolation: 'shared', files: ['old/'] });
    apply(state, [modRaw('[ASSIGN] @claude-1\ntask: 改做文件')]);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.task, '改做文件');
    for (const key of ['role', 'branch', 'isolation', 'files']) assert.equal(state[key], null, key);

    const s2 = assignedState({ task: '舊分工' });
    apply(s2, [modRaw('[ASSIGN] @claude-1\nrole: 後端\n\n細節寫在內文')]);
    assert.equal(s2.role, '後端');
    assert.equal(s2.task, null);
    assert.equal(s2.assignBody, '細節寫在內文');
  });

  test('files 依半形或全形逗號切開、去空白，存成字串陣列', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端\nisolation: shared\nfiles: src/ui, src/css，docs/a.md ，  README.md')]);
    assert.deepEqual(state.files, ['src/ui', 'src/css', 'docs/a.md', 'README.md']);
  });

  test('沒有 files 欄位時 files 是 null', () => {
    const state = makeState({ phase: 'topic', files: ['舊的'] });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端\nbranch: feat/login')]);
    assert.equal(state.files, null);
  });

  test('從 work、done 重新指派：回到 discussion、計數歸零、上限設回 null', () => {
    for (const phase of ['work', 'done']) {
      const state = assignedState({ phase, discussRound: 3, discussLimit: 5 });
      apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 後端')]);
      assert.equal(state.phase, 'discussion', phase);
      assert.equal(state.role, '後端', phase);
      assert.equal(state.discussRound, 0, phase);
      assert.equal(state.discussLimit, null, phase);
    }
  });

  test('角色經過 sanitizeRole', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: QA Lead (主)')]);
    assert.equal(state.role, 'QA-Lead-主');
  });

  test('files 只用半形、全形逗號切，「、」不是分隔', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端\nisolation: shared\nfiles: 說明、附錄.md, src/a.js')]);
    assert.deepEqual(state.files, ['說明、附錄.md', 'src/a.js']);
  });

  test('有 branch、沒寫 isolation 時預設 worktree', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端\nbranch: feat/login')]);
    assert.equal(state.isolation, 'worktree');
  });

  test('@全體 的 ASSIGN 對我生效', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @全體\nrole: 評審')]);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.assigned, true);
    assert.equal(state.role, '評審');
  });

  test('@ 別人：狀態不變', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @claude-2\nrole: 後端\ntask: API\nbranch: feat/api')]);
    assert.equal(state.phase, 'topic');
    assert.equal(state.assigned, false);
    assert.equal(state.role, null);
    assert.equal(state.task, null);
    assert.equal(state.branch, null);
  });

  test('只 @ 我的角色：不生效', () => {
    const state = makeState({ phase: 'topic', role: '前端' });
    apply(state, [modRaw('[ASSIGN] @前端\nrole: 後端')]);
    assert.equal(state.phase, 'topic');
    assert.equal(state.role, '前端');
    assert.equal(state.assigned, false);
  });

  test('只在內文 @ 我：不生效', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] 分工\nrole: 前端\n\n@claude-1 負責')]);
    assert.equal(state.phase, 'topic');
    assert.equal(state.assigned, false);
  });
});

describe('applyDirectives：GO、CONTINUE、STOP、CLOSE', () => {
  test('GO：已指派、討論中的 agent 階段改為 work', () => {
    const state = assignedState();
    const notes = apply(state, [modRaw('[GO]')]);
    assert.equal(state.phase, 'work');
    assert.ok(notes.length >= 1);
  });

  test('GO 沒有 @：沒被指派的 agent 不受影響', () => {
    const state = makeState({ phase: 'topic', assigned: false });
    apply(state, [modRaw('[GO]')]);
    assert.equal(state.phase, 'topic');
  });

  test('GO 只 @ 別人：不生效；@ 我的角色或廣播：生效；只在第二行 @ 別人：照第一行沒 @ 處理', () => {
    let state = assignedState();
    apply(state, [modRaw('[GO] @claude-2')]);
    assert.equal(state.phase, 'discussion');

    state = assignedState();
    apply(state, [modRaw('[GO] @前端')]);
    assert.equal(state.phase, 'work');

    state = assignedState();
    apply(state, [modRaw('[GO] @全體')]);
    assert.equal(state.phase, 'work');

    state = assignedState();
    apply(state, [modRaw('[GO]\n\n@claude-2 你負責收尾')]);
    assert.equal(state.phase, 'work');
  });

  test('GO @我：沒被指派也生效（第一行有 @ 不看階段）', () => {
    const state = makeState({ phase: 'topic', assigned: false });
    apply(state, [modRaw('[GO] @claude-1')]);
    assert.equal(state.phase, 'work');
  });

  test('CONTINUE n：階段 discussion、計數歸零、discussLimit 設為 n', () => {
    const state = assignedState({ discussRound: 3, discussLimit: null });
    const notes = apply(state, [modRaw('[CONTINUE] 2')]);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.discussRound, 0);
    assert.equal(state.discussLimit, 2);
    assert.ok(notes.length >= 1);
  });

  test('CONTINUE 的 n：去掉 @ token 與 <@ID> 後的第一個整數，在 @ 前後都可以', () => {
    for (const [title, want] of [
      ['4 @claude-1', 4],
      ['@claude-1 3', 3],
      ['<@123456789012345678> 2 @claude-1', 2],
      ['@claude-1', null],
      ['@claude-1 @gemini-2', null],
      ['@claude-1 <@123456789012345678>', null],
    ]) {
      const state = assignedState({ discussRound: 3, discussLimit: 9 });
      apply(state, [modRaw(`[CONTINUE] ${title}`)]);
      assert.equal(state.discussLimit, want, title);
      assert.equal(state.discussRound, 0, title);
    }
  });

  test('CONTINUE 的 n：@ 名稱裡的數字不算；第一行只有 <@ID> 照沒有 @ 處理', () => {
    let state = makeState({ name: 'claude-12', assigned: true, phase: 'discussion', discussRound: 3, discussLimit: 7 });
    apply(state, [modRaw('[CONTINUE] @claude-12')]);
    assert.equal(state.discussLimit, null);
    assert.equal(state.discussRound, 0);

    state = assignedState({ discussRound: 3, discussLimit: 7 });
    apply(state, [modRaw(`[CONTINUE] <@${MOD_ID}>`)]);
    assert.equal(state.discussLimit, null);
    assert.equal(state.discussRound, 0);
  });

  test('CONTINUE n @我：從 work 回到 discussion', () => {
    const state = assignedState({ phase: 'work', discussRound: 3 });
    apply(state, [modRaw('[CONTINUE] 2 @claude-1')]);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.discussLimit, 2);
    assert.equal(state.discussRound, 0);
  });

  test('CONTINUE 沒有 @：work 階段的 agent 不受影響', () => {
    const state = assignedState({ phase: 'work', discussRound: 3, discussLimit: null });
    apply(state, [modRaw('[CONTINUE] 2')]);
    assert.equal(state.phase, 'work');
    assert.equal(state.discussRound, 3);
    assert.equal(state.discussLimit, null);
  });

  test('CONTINUE 沒寫 n：上限回到議題的 rounds', () => {
    const state = assignedState({
      discussRound: 3, discussLimit: 7,
      topic: { id: '1', title: 't', fields: { rounds: '5' }, body: '' },
    });
    apply(state, [modRaw('[CONTINUE]')]);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.discussRound, 0);
    assert.equal(state.discussLimit, null);
  });

  test('CONTINUE 沒寫 n、議題也沒 rounds：上限回到 maxDiscussionRounds', () => {
    const state = assignedState({
      discussRound: 3, discussLimit: 7,
      topic: { id: '1', title: 't', fields: {}, body: '' },
    });
    apply(state, [modRaw('[CONTINUE]')]);
    assert.equal(state.discussLimit, null);
  });

  test('CONTINUE 只 @ 別人：不生效', () => {
    const state = assignedState({ discussRound: 3, discussLimit: null });
    apply(state, [modRaw('[CONTINUE] 2 @claude-2')]);
    assert.equal(state.discussRound, 3);
    assert.equal(state.discussLimit, null);
  });

  test('STOP：記下停下前的階段，階段改為 stopped；@ 我也一樣；只 @ 別人時不生效', () => {
    let state = assignedState({ phase: 'work' });
    const notes = apply(state, [modRaw('[STOP]')]);
    assert.equal(state.phase, 'stopped');
    assert.equal(state.phaseBeforeStop, 'work');
    assert.ok(notes.length >= 1);

    state = assignedState({ phase: 'discussion' });
    apply(state, [modRaw('[STOP] @claude-1')]);
    assert.equal(state.phaseBeforeStop, 'discussion');

    state = assignedState({ phase: 'work' });
    apply(state, [modRaw('[STOP] @claude-1')]);
    assert.equal(state.phase, 'stopped');

    state = assignedState({ phase: 'work' });
    apply(state, [modRaw('[STOP] @claude-2')]);
    assert.equal(state.phase, 'work');
  });

  test('STOP 沒有 @：沒被指派的 agent 也停；closed、idle 不受影響', () => {
    let state = makeState({ phase: 'topic', assigned: false });
    apply(state, [modRaw('[STOP]')]);
    assert.equal(state.phase, 'stopped');

    for (const phase of ['closed', 'idle']) {
      state = assignedState({ phase });
      apply(state, [modRaw('[STOP]')]);
      assert.equal(state.phase, phase);
    }
  });

  test('stopped 之後收到對我生效的 GO、CONTINUE、ASSIGN 照常轉換', () => {
    let state = assignedState({ phase: 'stopped', phaseBeforeStop: 'discussion' });
    apply(state, [modRaw('[GO]')]);
    assert.equal(state.phase, 'work');

    state = assignedState({ phase: 'stopped', phaseBeforeStop: 'work' });
    apply(state, [modRaw('[CONTINUE] 1')]);
    assert.equal(state.phase, 'discussion');

    state = makeState({ phase: 'stopped' });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端')]);
    assert.equal(state.phase, 'discussion');
  });

  test('停下前已經 done 的 agent，收到沒有 @ 的 GO、CONTINUE 仍停著', () => {
    for (const cmd of ['[GO]', '[CONTINUE] 2']) {
      const state = assignedState({ phase: 'stopped', phaseBeforeStop: 'done' });
      apply(state, [modRaw(cmd)]);
      assert.equal(state.phase, 'stopped', cmd);
    }
  });

  test('done 的 agent 收到 STOP 後再收到沒有 @ 的 GO：仍停著', () => {
    const state = assignedState({ phase: 'done' });
    apply(state, [modRaw('[STOP]'), modRaw('[GO]')]);
    assert.equal(state.phase, 'stopped');
    assert.equal(state.phaseBeforeStop, 'done');
  });

  test('沒被指派而被 STOP 的 agent，收到沒有 @ 的 GO 仍停著', () => {
    const state = makeState({ phase: 'stopped', assigned: false });
    apply(state, [modRaw('[GO]')]);
    assert.equal(state.phase, 'stopped');
  });

  test('CLOSE：階段改為 closed，第一行 @ 別人也一樣', () => {
    let state = assignedState({ phase: 'work' });
    const notes = apply(state, [modRaw('[CLOSE]')]);
    assert.equal(state.phase, 'closed');
    assert.ok(notes.length >= 1);

    state = assignedState();
    apply(state, [modRaw('[CLOSE] @claude-2')]);
    assert.equal(state.phase, 'closed');
  });
});

describe('applyDirectives：清除 pendingQuestionId（§4.4）', () => {
  const Q = OWN_B;
  const asking = (over = {}) => assignedState({ pendingQuestionId: Q, ...over });

  test('對我生效的 ANSWER（第一行 @ 我）：清除，階段不變', () => {
    const state = asking({ phase: 'work' });
    apply(state, [modRaw('[ANSWER] @claude-1\n\n可以，照做')]);
    assert.equal(state.pendingQuestionId, null);
    assert.equal(state.phase, 'work');
  });

  test('ANSWER 的 to: 我的名稱（可帶 @、不分大小寫）', () => {
    for (const to of ['claude-1', '@claude-1', '＠Claude-1', 'CLAUDE-1']) {
      const state = asking();
      apply(state, [modRaw(`[ANSWER]\nto: ${to}\n\n可以`)]);
      assert.equal(state.pendingQuestionId, null, to);
    }
  });

  test('不認得的標籤視同沒有標籤：[FOO] @我 也清除（§4.1）', () => {
    const state = asking();
    apply(state, [modRaw('[FOO] @claude-1 可以')]);
    assert.equal(state.pendingQuestionId, null);
  });

  test('ANSWER 用 Discord 回覆我的問題', () => {
    const state = asking();
    apply(state, [modRaw('[ANSWER] 可以', replyTo(Q))]);
    assert.equal(state.pendingQuestionId, null);
  });

  test('主導者不加標籤、直接回覆我的問題', () => {
    const state = asking();
    apply(state, [modRaw('可以，照你說的做', replyTo(Q))]);
    assert.equal(state.pendingQuestionId, null);
    assert.equal(state.phase, 'discussion');
  });

  test('主導者回覆我發過的其他訊息（不是那則問題）也清除', () => {
    const state = asking();
    apply(state, [modRaw('好', replyTo(OWN_A))]);
    assert.equal(state.pendingQuestionId, null);
  });

  test('主導者帶標籤的訊息回覆我的訊息也清除', () => {
    const state = asking();
    apply(state, [modRaw('[STOP] @claude-2', replyTo(OWN_A))]);
    assert.equal(state.pendingQuestionId, null);
    assert.equal(state.phase, 'discussion');
  });

  test('問題已掉出 ownMessageIds，主導者回覆那則問題仍會清除', () => {
    const OLD_Q = '1100000000000000099';
    let state = asking({ ownMessageIds: [OWN_A], pendingQuestionId: OLD_Q });
    apply(state, [modRaw('[ANSWER] 可以', replyTo(OLD_Q))]);
    assert.equal(state.pendingQuestionId, null);

    state = asking({ ownMessageIds: [OWN_A], pendingQuestionId: OLD_Q });
    apply(state, [modRaw('可以', replyTo(OLD_Q))]);
    assert.equal(state.pendingQuestionId, null);
  });

  test('主導者沒有標籤、內文 @ 我的名稱：清除', () => {
    let state = asking();
    apply(state, [modRaw('@claude-1 可以，照做')]);
    assert.equal(state.pendingQuestionId, null);

    state = asking();
    apply(state, [modRaw('好的。\n請@Claude-1照做')]);
    assert.equal(state.pendingQuestionId, null);
  });

  test('主導者沒有標籤、只 @ 我的角色或廣播：不清除', () => {
    const state = asking();
    apply(state, [modRaw('@前端 可以'), modRaw('@全體 可以')]);
    assert.equal(state.pendingQuestionId, Q);
  });

  test('主導者有標籤（不是對我生效的 ANSWER）、內文 @ 我：不清除', () => {
    const state = asking();
    apply(state, [modRaw('[STOP] @claude-2\n\n@claude-1 你繼續')]);
    assert.equal(state.pendingQuestionId, Q);
  });

  test('ANSWER 給別人：不清除', () => {
    const state = asking();
    apply(state, [modRaw('[ANSWER] @claude-2\n\n可以')]);
    assert.equal(state.pendingQuestionId, Q);
    apply(state, [modRaw('[ANSWER]\nto: claude-2\n\n可以')]);
    assert.equal(state.pendingQuestionId, Q);
  });

  test('非主導者的 ANSWER、回覆、@ 我：都不清除', () => {
    const state = asking();
    apply(state, [
      agentRaw('claude-2 (後端)', '[ANSWER] @claude-1\n\n可以'),
      agentRaw('claude-2 (後端)', '@claude-1 可以', replyTo(Q)),
      humanRaw('[ANSWER] @claude-1\n\n可以'),
      humanRaw('可以', replyTo(Q)),
      humanRaw('@claude-1 可以'),
    ]);
    assert.equal(state.pendingQuestionId, Q);
  });
});

describe('applyDirectives：主導者的非指令訊息不改變狀態（§4.1、§4.2）', () => {
  // §4.4 的 pendingQuestionId 與 §5.4 的 emptyWaitSince 本來就會被一般訊息清除，不在比對之列。
  const KEYS = [
    'phase', 'role', 'task', 'branch', 'isolation', 'files', 'assigned', 'topic', 'discussRound', 'discussLimit',
    'phaseBeforeStop', 'assignMessageId', 'assignBody', 'workStartedAt',
  ];
  const pick = (s) => Object.fromEntries(KEYS.map((k) => [k, s[k]]));
  const contents = [
    '@claude-1 開始寫吧', '大家好', '@前端 先停一下', '@全體 GO',
    '[INFO] @claude-1 開始\nrole: 後端', '[DISCUSS] t\n\n@claude-1', '[DONE] x', '[PROGRESS] 50%\npercent: 50', '[IDLE]',
    '說明一下\n[GO]', '補充\n[TOPIC] 新題', '看這裡\n[CONTINUE] 2',
  ];
  for (const phase of ['discussion', 'work']) {
    test(`${phase} 階段`, () => {
      for (const content of contents) {
        const state = assignedState({
          phase, discussRound: 1, discussLimit: 4, assignMessageId: '1290000000000000001', assignBody: '細節',
          workStartedAt: phase === 'work' ? ISO(T0 - 600_000) : null,
          topic: { id: '1', title: '議題', fields: {}, body: '', attachments: [] },
        });
        const before = pick(state);
        apply(state, [modRaw(content)]);
        assert.deepEqual(pick(state), before, content);
      }
    });
  }
});

describe('applyDirectives：只有主導者的指令生效、自己的訊息不套用', () => {
  test('agent、人類、bot、其他 webhook 發的主導者標籤都不生效', () => {
    const state = assignedState();
    apply(state, [
      agentRaw('claude-2 (後端)', '[GO]'),
      humanRaw('[TOPIC] 假議題'),
      botRaw('[CLOSE]'),
      otherWebhookRaw('[STOP]'),
      humanRaw('[ASSIGN] @claude-1\nrole: 後端'),
    ]);
    assert.equal(state.phase, 'discussion');
    assert.equal(state.role, '前端');
    assert.equal(state.topic, null);
  });

  test('自己的訊息不套用', () => {
    const state = assignedState();
    apply(state, [agentRaw('claude-1 (前端)', '[STOP]'), agentRaw('claude-1', '[CLOSE]')]);
    assert.equal(state.phase, 'discussion');
  });
});

describe('applyDirectives：emptyWaitSince（§5.4）', () => {
  const SINCE = ISO(T0 - 600_000);

  for (const [label, make] of [
    ['主導者', () => modRaw('大家好')],
    ['其他 agent', () => agentRaw('claude-2 (後端)', '[DISCUSS] t\n\n看法')],
    ['人類', () => humanRaw('hi')],
    ['bot', () => botRaw('hi')],
  ]) {
    test(`${label}的訊息清除 emptyWaitSince`, () => {
      const state = assignedState({ emptyWaitSince: SINCE });
      apply(state, [make()]);
      assert.equal(state.emptyWaitSince, null);
    });
  }

  test('別的 agent 的 [JOIN]、[LEAVE]、[IDLE] 不清除', () => {
    const state = assignedState({ emptyWaitSince: SINCE });
    apply(state, [
      agentRaw('gemini-2', '[JOIN] gemini-2\nvendor: gemini'),
      agentRaw('codex-1 (評審)', '[LEAVE] codex-1'),
      agentRaw('claude-3', '[IDLE] claude-3'),
    ]);
    assert.equal(state.emptyWaitSince, SINCE);
  });

  test('只有自己的訊息時不清除', () => {
    const state = assignedState({ emptyWaitSince: SINCE });
    apply(state, [agentRaw('claude-1 (前端)', '[DISCUSS] t\n\n看法')]);
    assert.equal(state.emptyWaitSince, SINCE);
  });

  test('沒有訊息時不清除', () => {
    const state = assignedState({ emptyWaitSince: SINCE });
    assert.deepEqual(applyDirectives(state, [], ROOM), []);
    assert.equal(state.emptyWaitSince, SINCE);
  });
});

describe('applyDirectives：依序逐則套用、每則用當下的狀態判斷對象', () => {
  test('TOPIC → ASSIGN → GO（沒有 @）同一批：ASSIGN 之後已被指派，GO 生效', () => {
    const state = makeState();
    const notes = apply(state, [
      modRaw('[TOPIC] 議題'),
      modRaw('[ASSIGN] @claude-1\nrole: 前端\nbranch: feat/ui'),
      modRaw('[GO]'),
    ]);
    assert.equal(state.phase, 'work');
    assert.equal(state.role, '前端');
    assert.equal(state.assigned, true);
    assert.equal(state.topic.title, '議題');
    assert.ok(notes.length >= 1);
  });

  test('GO → STOP：stopped；STOP → GO：work', () => {
    let state = assignedState();
    apply(state, [modRaw('[GO]'), modRaw('[STOP]')]);
    assert.equal(state.phase, 'stopped');

    state = assignedState();
    apply(state, [modRaw('[STOP]'), modRaw('[GO]')]);
    assert.equal(state.phase, 'work');
  });

  test('ASSIGN 之後的 TOPIC 會清掉剛設定的角色與 assigned', () => {
    const state = makeState({ phase: 'topic' });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端'), modRaw('[TOPIC] 換題')]);
    assert.equal(state.phase, 'topic');
    assert.equal(state.role, null);
    assert.equal(state.assigned, false);
  });

  test('TOPIC 之後同一批的 GO（沒有 @）：已不是被指派狀態，不生效', () => {
    const state = assignedState();
    apply(state, [modRaw('[TOPIC] 換題'), modRaw('[GO]')]);
    assert.equal(state.phase, 'topic');
  });

  test('同一批先 ASSIGN 角色、再 GO @該角色：GO 依當下的角色對我生效', () => {
    const state = makeState({ phase: 'topic', role: null });
    apply(state, [modRaw('[ASSIGN] @claude-1\nrole: 前端'), modRaw('[GO] @前端')]);
    assert.equal(state.role, '前端');
    assert.equal(state.phase, 'work');
  });
});

// ---- §5.3、§7.1 reminders ----

describe('reminders（§5.3、§7.1）', () => {
  const NOW = T0;
  const withTopic = (rounds) => ({ id: '1', title: 't', fields: rounds == null ? {} : { rounds: String(rounds) }, body: '' });

  test('回傳字串陣列', () => {
    const list = reminders(makeState({ phase: 'discussion' }), ROOM, NOW);
    assert.ok(Array.isArray(list));
    for (const s of list) assert.equal(typeof s, 'string');
  });

  test('達到上限時提示 wait --until moderator', () => {
    const list = reminders(makeState({ phase: 'discussion', discussRound: 3 }), ROOM, NOW);
    assert.ok(list.some((s) => s.includes('wait --until moderator')), JSON.stringify(list));
  });

  test('上限的優先順序：discussLimit > 議題 rounds > maxDiscussionRounds', () => {
    // 兩邊用同一個議題（同標題），只改被覆蓋的那一層，避免提醒裡帶到議題名稱造成誤判。
    const r = (over, room = ROOM) => reminders(makeState({ phase: 'discussion', discussRound: 3, ...over }), room, NOW);
    const room9 = { ...ROOM, maxDiscussionRounds: 9 };
    const atLimit = (list) => list.some((s) => s.includes('wait --until moderator'));
    // 上限由高優先的那一層決定：只改低優先的層，提醒不變。
    assert.deepEqual(r({ discussLimit: 5, topic: withTopic(3) }), r({ discussLimit: 5, topic: withTopic(9) }));
    assert.deepEqual(r({ discussLimit: 5, topic: withTopic(3) }), r({ discussLimit: 5, topic: withTopic(3) }, room9));
    assert.deepEqual(r({ discussLimit: null, topic: withTopic(5) }), r({ discussLimit: null, topic: withTopic(5) }, room9));
    // 每一層都有作用（已發 3 則：上限 3 到了，上限 5 或 9 沒到）。
    assert.notDeepEqual(r({ discussLimit: 5, topic: withTopic(3) }), r({ discussLimit: 3, topic: withTopic(3) }));
    assert.notDeepEqual(r({ discussLimit: null, topic: withTopic(5) }), r({ discussLimit: null, topic: withTopic(3) }));
    assert.notDeepEqual(r({ discussLimit: null, topic: withTopic(null) }), r({ discussLimit: null, topic: withTopic(null) }, room9));
    // 到上限時提示 wait --until moderator。
    assert.ok(atLimit(r({ discussLimit: 3, topic: withTopic(9) }, room9)));
    assert.ok(atLimit(r({ discussLimit: null, topic: withTopic(3) }, room9)));
    assert.ok(atLimit(r({ discussLimit: null, topic: withTopic(null) })));
  });

  test('工作階段：距上次 [PROGRESS] 超過 progressReminderMin 才提醒', () => {
    const r = (minutesAgo, room = ROOM) =>
      reminders(
        makeState({ phase: 'work', workStartedAt: ISO(NOW - 120 * 60_000), lastProgressAt: ISO(NOW - minutesAgo * 60_000) }),
        room,
        NOW,
      );
    const late = r(16);
    const fresh = r(5);
    assert.ok(late.length > fresh.length, `16 分：${JSON.stringify(late)}；5 分：${JSON.stringify(fresh)}`);
    assert.ok(late.some((s) => /progress/i.test(s)), JSON.stringify(late));
    // 讀 room.progressReminderMin，不寫死 15。
    assert.equal(r(16, { ...ROOM, progressReminderMin: 30 }).length, fresh.length);
  });

  test('工作階段還沒回報過進度：從開始工作算起', () => {
    const r = (minutesAgo) =>
      reminders(makeState({ phase: 'work', workStartedAt: ISO(NOW - minutesAgo * 60_000), lastProgressAt: null }), ROOM, NOW);
    assert.ok(r(20).length > r(5).length);
  });

  for (const phase of ['stopped', 'closed', 'idle']) {
    test(`${phase} 階段有指示`, () => {
      assert.ok(reminders(makeState({ phase }), ROOM, NOW).length >= 1);
    });
  }
});
