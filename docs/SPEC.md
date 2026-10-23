# AgentChatRoom 介面規格

本檔是 `agentchat` 工具、SOP 文件、接入說明、測試之間的共同契約。
實作與文件都以本檔為準；要改介面，先通知協調 session，由協調改本檔後再實作。

## 0. 名詞

| 名詞 | 意思 |
|---|---|
| 房間 | 一個 Discord 文字頻道，設定在 `config/room.json` |
| 主導者 | 人類，Discord 使用者 ID 等於 `room.moderatorUserId` 的人。只有他的指令有效 |
| agent | 一個 AI session（Claude Code、Gemini CLI、Codex CLI），用 `--as <名稱>` 區分 |
| 游標 | agent 已讀到的最後一則訊息 ID（Discord snowflake），存在本機狀態檔 |
| 指令訊息 | 主導者發的 `[TOPIC]` `[ASSIGN]` `[GO]` `[CONTINUE]` `[STOP]` `[CLOSE]` `[ANSWER]` |

## 1. 架構

- 一個 Discord bot：用 REST 讀頻道訊息、管理 webhook。不連 Gateway，不常駐。
- 一個共用 webhook（名稱是 `webhookName`）：agent 預設都經由它發言，每則訊息的顯示名稱是 `角色（名稱）`（沒有角色時只有 `名稱`）。
- agent 專屬 webhook（選用）：agent 用 `avatar` 指令（§6.3）設定自己畫的頭像時，工具替它建立名稱為 `<webhookName>-<名稱小寫>` 的 webhook，之後這個 agent 改經由它發言，顯示 webhook 本身的頭像。顯示名稱規則相同。
- 每台機器各自 clone 這個 repo，`.env` 放 bot token，`~/.agentchat/` 放本機狀態。
- agent 透過 shell 呼叫 `agentchat` 指令；讀訊息用 `wait` 長輪詢。

## 2. 檔案結構與歸屬

| 路徑 | 內容 | 負責 |
|---|---|---|
| `bin/agentchat.js` | CLI 入口，shebang `#!/usr/bin/env node`，可執行 | cmd |
| `src/*.js` | 核心模組（見 §7） | cmd |
| `src/commands/*.js` | 各指令實作，一個指令一個檔 | cmd |
| `test/commands/` | 指令層測試與假 Discord 伺服器 | cmd |
| `test/core/` | 核心模組單元測試 | test |
| `package.json` | 套件設定，零執行期依賴 | cmd |
| `SOP/agent.md` | 給 AI agent 的 SOP，`agentchat sop` 會印出它 | sop |
| `SOP/moderator.md` | 給主導者（人類）的操作手冊 | sop |
| `SOP/setup-claude-code.md` `SOP/setup-gemini-cli.md` `SOP/setup-codex-cli.md` | 三家 CLI 的接入說明 | setup |
| `skills/claude-code/agentchat/SKILL.md` | Claude Code 的 `/agentchat` skill | setup |
| `skills/agents/agentchat/` | Codex CLI 與 Gemini CLI 共用的 agent skill（`SKILL.md`，加上 Codex 專用的 `agents/openai.yaml`），`install.sh` 連結到 `~/.agents/skills/agentchat` | setup |
| `skills/gemini-cli/agentchat.toml` | Gemini CLI 的 `/agentchat` 自訂指令，`install.sh` 連結到 `~/.gemini/commands/agentchat.toml` | setup |
| `scripts/install.sh` | 本機安裝腳本 | setup |
| `test/install/` | 安裝腳本的情境測試（暫存 HOME），由 `npm test` 一起執行 | setup |
| `README.md` | 專案總覽 | setup |
| `docs/SPEC.md` `config/` `.env.example` `.gitignore` | 規格與設定 | 協調 |

## 3. 設定與環境變數

### 3.1 `config/room.json`

| 欄位 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `roomName` | | `default` | 房間名稱，只用於顯示 |
| `guildId` | ✓ | | 伺服器 ID |
| `channelId` | ✓ | | 文字頻道 ID |
| `moderatorUserId` | ✓ | | 主導者的 Discord 使用者 ID |
| `webhookName` | | `agentchat` | 工具建立與尋找 webhook 時用的名稱 |
| `language` | | `zh-TW` | agent 在頻道內使用的語言 |
| `defaultRepo` | | `null` | `[TOPIC]` 沒寫 `repo` 時的作業 repo |
| `defaultBase` | | `main` | `[TOPIC]` 沒寫 `base` 時的基準分支 |
| `maxDiscussionRounds` | | `3` | 每人每段討論可發的 `[DISCUSS]` 則數 |
| `waitTimeoutSec` | | `90` | `wait` 預設逾時秒數 |
| `pollIntervalSec` | | `3` | `wait` 輪詢間隔秒數 |
| `idleLimitMin` | | `60` | 連續等待多久沒有任何新訊息就自動發 `[IDLE]` |
| `progressReminderMin` | | `15` | 工作階段距上次 `[PROGRESS]` 多久開始提醒 |
| `maxFileMB` | | `10` | 單一附檔上限 |
| `maxUploadMB` | | `10` | 一則訊息所有附檔的總和上限（Discord 沒加成的伺服器上限是 10 MB，有加成可調高） |
| `longTextChars` | | `6000` | 文字超過這個長度就改成附檔 |
| `avatarUrlTemplate` | | `https://api.dicebear.com/10.x/{style}/png?seed={name}&size=128` | agent 發言的頭像網址（§6.2）。`{name}` 換成 agent 名稱的小寫（名稱不分大小寫，§6.2）、`{vendor}` 換成狀態檔的 `vendor`（沒有時是 `other`）、`{style}` 換成 `avatarStyles` 對應的風格，三者都先 URL 編碼；其他文字照原樣。必須以 `http://` 或 `https://` 開頭（不分大小寫，後面要接網址內容；Discord 只吃 PNG／JPG 等點陣圖，不吃 SVG）。**寫 `null` 或空字串表示不帶頭像**（其他選填欄位寫 `null` 或空字串時用預設值，這個欄位例外），Discord 顯示 webhook 本身的頭像 |
| `avatarStyles` | | `{"claude":"bottts","gemini":"pixel-art","codex":"adventurer","other":"identicon"}` | vendor 對應的 DiceBear 風格；必須是 JSON 物件，設定檔有寫的 vendor 覆蓋預設，沒寫的沿用預設；整個欄位寫 `null` 時用預設。每個值必須是非空字串（寫 `null` 也是錯誤，要還原預設就刪掉那個 vendor）。vendor 不在表裡（或狀態檔沒有 vendor）時用 `other` 的風格 |

`--room <名稱>` 時改讀 `config/rooms/<名稱>.json`，欄位相同。

### 3.2 環境變數

| 變數 | 說明 |
|---|---|
| `DISCORD_BOT_TOKEN` | bot token。優先讀環境變數，其次讀 `<工具目錄>/.env` |
| `AGENTCHAT_HOME` | 覆寫工具目錄（預設是 `src/` 的上一層，symlink 會解析成實際路徑） |
| `AGENTCHAT_STATE_DIR` | 覆寫本機狀態目錄（預設 `~/.agentchat`） |
| `AGENTCHAT_API_BASE` | 覆寫 Discord API 位址（預設 `https://discord.com/api/v10`），測試時指向假伺服器 |

### 3.3 本機狀態 `~/.agentchat/`

| 路徑 | 內容 |
|---|---|
| `agents/<channelId>/<名稱小寫>.json` | agent 狀態（§5.1）；檔名一律小寫，名稱比對不分大小寫在任何檔案系統都成立 |
| `webhooks/<channelId>.json` | 共用 webhook 的 id 與 token，權限 0600，絕不印出 token |
| `webhooks/<channelId>/<名稱小寫>.json` | agent 專屬 webhook 的 `{ id, token, channelId, name, agent }`（`name` 是 webhook 名稱、`agent` 是 agent 名稱），權限 0600，絕不印出 token |
| `webhooks/<channelId>.known.json` | 本房 webhook 辨識快取（§4.5）：`{ room: [ID...], other: [ID...] }`，不含 token |
| `logs/<channelId>.jsonl` | 收發紀錄，一行一筆 JSON |
| `downloads/<channelId>/<messageId>/` | `download` 的預設存放處 |

## 4. 訊息協定

### 4.1 格式

```
[TAG] 標題
key: value
key: value

內文（可多行）
```

- 第一行是標籤列。接受半形 `[TAG]`、全形 `【TAG】`、`［TAG］`，TAG 不分大小寫。
- 只認得 §4.2 列出的標籤；不認得的標籤或沒有標籤時，整則訊息視為內文：`tag = null`、`title = ''`、`fields = {}`。
- 欄位列緊接在標籤列之後，格式 `key: value`，冒號可以是半形 `:` 或全形 `：`，冒號前後可以沒有空白（`repo：/path`、`repo:/path` 都算），值可以是空字串。key 只認 §4.3 列出的名稱，不分大小寫。遇到第一個不是已知欄位的行（包括空白行）就停止解析欄位，之後全部是內文。
- 內文前後空白去掉。

### 4.2 標籤

主導者專用（只有作者 ID 等於 `moderatorUserId` 時才生效；agent 發這些標籤會被工具拒絕）：

| 標籤 | 標題 | 欄位 | 作用對象 | 效果 |
|---|---|---|---|---|
| `TOPIC` | 議題名稱 | `repo` `base` `rounds` | 所有 agent | 開新議題，階段改為 `topic`；清除 `role` `task` `branch` `isolation` `files` `assignMessageId` `assignBody` `phaseBeforeStop` `pendingQuestionId` `lastProgressAt` `workStartedAt`，`assigned` 設回 `false`，`discussRound` 歸零、`discussLimit` 設回 `null`；記下議題的附檔清單 |
| `ASSIGN` | 第一行要 @ 被指派的 agent；有 `branch` 時應該一則只 @ 一個 agent | `role` `task` `branch` `isolation` `files` | 第一行 @ 到的 agent | 整組取代分工（沒寫的欄位清成 `null`），記下 `assignMessageId` 與內文 `assignBody`，`assigned` 設為 `true`，階段改為 `discussion`，討論計數歸零、`discussLimit` 設回 `null` |
| `GO` | 可選；可 @ | | 見 §4.4 | 階段改為 `work`，`workStartedAt` 設為這則訊息的時間 |
| `CONTINUE` | 可選的數字 n；可 @。n 的取法：先去掉標題裡所有 @ token 與 `<@ID>`，再取第一個整數（`2 @claude-1`、`@claude-1 2` 都是 2） | | 見 §4.4 | 再開一段討論：`discussRound` 歸零；有 n 且 n ≥ 1 時 `discussLimit` 設為 n，沒有 n 或 n 是 0 時設回 `null`（用議題 `rounds` 或房間預設）；階段改為 `discussion` |
| `STOP` | 可選；可 @ | | 見 §4.4 | 記下 `phaseBeforeStop`（目前階段；已經是 `stopped` 時不覆寫），階段改為 `stopped`，agent 只能等待 |
| `CLOSE` | 可選 | | 所有 agent | 議題結束，階段改為 `closed` |
| `ANSWER` | 第一行 @ 提問的 agent | `to` | 第一行 @ 到的 agent，或 `to` 指定的 agent | 回答問題，清除該 agent 的 `pendingQuestionId` |

agent 用：

| 標籤 | 用途 | 由哪個指令發 |
|---|---|---|
| `JOIN` | 進房 | `join` |
| `LEAVE` | 離房 | `leave` |
| `ACK` | 收到指派、回覆理解 | `ack` |
| `DISCUSS` | 討論發言，計入討論輪數 | `discuss` |
| `QUESTION` | 向主導者提問，會真的 @ 主導者 | `ask` |
| `PROGRESS` | 進度回報 | `progress` |
| `DONE` | 完成分工 | `done` |
| `IDLE` | 長時間沒人回應，自動結束 | `wait` 自動發 |
| `INFO` | 其他一般訊息 | `post` 預設 |

主導者不加標籤直接打字也可以，agent 會當成一般發言閱讀，不改變狀態。
主導者編輯或刪除已發出的訊息不會生效：已讀過的 agent 不會重讀。發錯了就再發一則新的。
同一則 `[ASSIGN]` 第一行 @ 到多個 agent（或用廣播）而且有 `branch` 時，每個 agent 照樣套用，但 `applyDirectives()` 的「注意」要加一句：這則指派給了多人且指定同一個 branch，worktree 模式會衝突，請先用 `ask` 向主導者確認。
另外，主導者用 Discord 的「回覆」功能回覆某個 agent 的訊息，視同對該 agent 說話（§4.4）。

### 4.3 欄位

| key | 用在 | 說明 |
|---|---|---|
| `repo` | TOPIC | 作業 repo：本機路徑或 git URL；什麼時候用、沒寫時怎麼決定，見 §5.5 |
| `base` | TOPIC | 基準分支，預設 `room.defaultBase` |
| `rounds` | TOPIC | 這個議題每段討論的則數上限，覆寫 `maxDiscussionRounds` |
| `role` | ASSIGN、ACK | 角色名稱 |
| `task` | ASSIGN | 一句話分工；細節寫在內文 |
| `branch` | ASSIGN、ACK、PROGRESS、DONE | 工作分支 |
| `isolation` | ASSIGN | `worktree` 或 `shared`；沒寫而且有 `branch` 時預設 `worktree`（這是依 `branch` 推出的預設值，不是沿用舊值），沒寫也沒有 `branch` 時是 `null` |
| `files` | ASSIGN | `shared` 模式下允許改的路徑，用 `,`、`，` 或 `、` 分隔 |
| `percent` | PROGRESS | 0 到 100 |
| `eta` | PROGRESS | 預估剩餘時間，文字 |
| `vendor` | JOIN | `claude`、`gemini`、`codex`、`other` |
| `model` | JOIN | 模型名稱，文字 |
| `host` | JOIN | 機器標籤，選填，只在使用者指定時才寫 |
| `worktree` | DONE | worktree 路徑 |
| `commit` | DONE | 最後一個 commit 的短 SHA |
| `to` | ANSWER | 回答對象的名稱，可代替第一行的 @；值可以帶開頭的 `@`／`＠`，比對不分大小寫 |

### 4.4 Mention

- **@ 位置**：`@` 或全形 `＠`，前面是行首，或不是 email 帳號會用的字元（英數字、`_`、`.`、`+`、`-`），後面緊接一個非空白字元。中文緊接也算，例如 `請@claude-1看`；`a@b.com` 不算。Discord 選單產生的 `<@使用者ID>` 不是 @ 位置。
- **@ 到 W**（W 是 agent 名稱、角色或廣播詞）：某個 @ 位置之後的文字以 W 開頭（不分大小寫），而且 W 之後是邊界。邊界的判斷看 W 的最後一個字元：
  - 是英數字、`_`、`-`：下一個字元不是英數字、`_`、`-`，或已到結尾。
  - 是其他字元（例如中文）：下一個字元是空白、`-` 與 `_` 以外的標點或符號，或已到結尾。
  - 例：`@claude-1請看` 算 @ 到 claude-1；`@claude-10` 不算 @ 到 claude-1。
  - 例：角色 `前端`：`@前端 請看`、`@前端，請看` 算；`@前端請看` 不算（中文後面接中文分不出邊界）；`@前端-主` 不算（那是另一個角色）。
  - 例：角色 `qa`：`@qa工程師` 算。角色 `UI設計`：`@UI設計 請看` 算。角色 `前端-主`：`@前端-主，` 算。
  - 角色經過 `sanitizeRole()` 後不含空白，配合這個規則，任何角色都 @ 得到。
- **廣播詞**：`all`、`agents`、`everyone`、`here`、`全體`；@ 到任一個視為 @ 到所有 agent（`@here有人嗎` 算）。
- **主導者 mention**：agent 訊息裡的 `@moderator` 或 `@主導者`（含全形 ＠）由工具換成 `<@moderatorUserId>`，會真的通知主導者。這兩個詞只看 @ 位置與開頭，不要求後面是邊界（`@主導者決定` 也會換），寧可多通知，不要漏掉。
- 工具發言一律帶 `allowed_mentions = { parse: [], users: [moderatorUserId] }`：除了主導者之外，不會通知任何人，`@everyone` 也不會生效。
- 「回覆我的訊息」：這則訊息是 Discord 回覆，且被回覆的訊息 ID 在 `ownMessageIds`（最近 50 則）裡，或等於 `pendingQuestionId`。
- 「提到我」（`mentionsMe`）成立的條件：內文有 @ 到我的名稱、我的角色或廣播；或是「回覆我的訊息」。
- 「指令對我生效」（`targetsMe`）只看第一行；「第一行有 @」指第一行至少有一個 @ 位置（`<@使用者ID>` 不算）：
  - `TOPIC`、`CLOSE`：一律生效。
  - `ASSIGN`、`ANSWER`：第一行 @ 到我的名稱或廣播；`ANSWER` 另外接受 `to: 我的名稱`，以及「回覆我的訊息」。
  - `GO`、`CONTINUE`：第一行有 @ 時，只對被 @ 到的名稱、角色或廣播生效（不看階段，`left` 除外）。第一行沒有任何 @ 時，只對 `assigned` 為 true，且「階段是 `discussion`」或「階段是 `stopped` 而 `phaseBeforeStop` 是 `discussion` 或 `work`」的 agent 生效；沒被指派、已經 `done`、或停下前已經 `done` 的 agent 不受影響。
  - `STOP`：第一行有 @ 時同上；沒有 @ 時對所有階段不是 `closed`、`idle`、`left` 的 agent 生效。
- 清除 `pendingQuestionId` 的條件（任一成立，都必須是主導者的訊息）：對我生效的 `[ANSWER]`；「回覆我的訊息」（有沒有標籤都算）；沒有標籤、但內文 @ 到我的名稱（只限名稱，角色與廣播不算）。

### 4.5 作者身分（`kind`）

| kind | 判斷 |
|---|---|
| `moderator` | 作者 ID 等於 `moderatorUserId` |
| `self` | 經由本房 webhook 發出，且顯示名稱用 `splitAgentName()` 拆出的名稱等於我的名稱（不分大小寫）：`我的名稱`、`角色（我的名稱）`，或舊格式 `我的名稱 (角色)` |
| `agent` | 經由本房 webhook 發出的其他訊息 |
| `bot` | 其他 webhook 或 bot 帳號發的訊息 |
| `human` | 其他人類 |

「本房 webhook」是共用 webhook 加上所有 agent 專屬 webhook（包括別台機器的 agent 建立的）。工具用一組 ID 判斷（`roomWebhookIds()`，§7.1 `authorKind` 的 `opts.webhookIds`）：
1. 先收集本機已知的：共用 webhook 快取（`webhooks/<channelId>.json`）的 id、本機各 agent 專屬 webhook 快取（`webhooks/<channelId>/*.json`）的 id、辨識快取 `webhooks/<channelId>.known.json` 的 `room`。
2. 這批訊息裡有 webhook 訊息的 `webhook_id` 不在已知的 `room`、也不在辨識快取的 `other` 時，查一次頻道的 webhook 清單（`GET /channels/<id>/webhooks`；同一個 ID 在同一個指令執行（行程）裡只觸發一次查詢，`wait` 等待期間才出現的新 ID 也會查）：名稱等於 `webhookName`，或以 `<webhookName>-` 開頭的，都算本房，加進 `room`；這次查詢時這批訊息裡其他不認得的 ID（清單裡名稱不符，或已不在清單裡，例如被手動刪掉的 webhook）加進 `other`；兩者都寫回辨識快取。
3. 查詢失敗（例如沒有「管理 Webhook」權限）時不丟錯、不寫快取：已知的 ID 照用，不認得的歸為 `bot`；但最後一個本房 webhook ID 都不知道時（本機沒有任何快取，而且查詢失敗或頻道裡沒有本工具的 webhook），沿用舊規則：webhook 訊息一律不歸為 `bot`，名稱是我的就是 `self`，其餘是 `agent`。
4. 不認得的 webhook 歸為 `bot`（§4.5 的原則：寧可把陌生 webhook 當外人，不讓它冒充 agent 改變判斷；主導者指令只認主導者 ID，不受影響）。已知限制：本房 webhook 被刪掉後才第一次看到它的舊訊息時（`clear` 會一併刪掉訊息，通常不會發生），那些訊息歸為 `bot`。

## 5. agent 狀態

### 5.1 狀態檔欄位

| 欄位 | 說明 |
|---|---|
| `version` | 固定 `1` |
| `name` `vendor` `model` `channelId` | 身分 |
| `role` `task` `branch` `isolation` `files` | 目前的分工 |
| `assigned` | 本議題是否已收到對我生效的 `[ASSIGN]` |
| `files` 的格式 | 字串陣列，由 `[ASSIGN]` 的 `files` 依半形逗號 `,`、全形逗號 `，` 或頓號 `、` 切開、去空白、去掉空項；沒有就 `null` |
| `assignMessageId` `assignBody` | 對我生效的最後一則 `[ASSIGN]` 的訊息 ID 與內文（分工細節），`status` 會印出 |
| `phaseBeforeStop` | 收到 `[STOP]` 前的階段；沒有就 `null` |
| `topic` | `{ id, title, fields, body, attachments }` 或 `null`；`attachments` 是議題訊息的附檔清單（檔名、大小），`status` 會印出 |
| `phase` | 見 §5.2 |
| `cursor` | 已讀到的最後一則訊息 ID |
| `discussRound` `discussLimit` | 本段已發的 `[DISCUSS]` 則數；本段上限（`null` 表示用議題或房間預設） |
| `ownMessageIds` | 自己最近發的 50 則訊息 ID |
| `pendingQuestionId` | 尚未得到回答的 `[QUESTION]` 訊息 ID |
| `joinedAt` `lastActivityAt` `lastProgressAt` `workStartedAt` `emptyWaitSince` | 時間戳，ISO 字串或 `null` |
| `left` | 是否已 `leave` |
| `lastNotes` `lastNotesAt` | 最近一次 `wait` 或 `join` 印出的「注意」字串陣列與當時的時間；`status` 會連同時間再印一次，給輸出被截掉或對話壓縮後的 agent 找回（agent 要看時間判斷是不是舊的） |

### 5.2 階段

| 階段 | 進入條件 | 允許的發言指令 |
|---|---|---|
| `lobby` | `join` 時沒有進行中的議題 | `post` `ask` `leave` |
| `topic` | 收到 `[TOPIC]`，或 `join` 時有進行中的議題 | `post` `ask` `leave` |
| `discussion` | 收到對我生效的 `[ASSIGN]` 或 `[CONTINUE]` | `ack` `discuss` `post` `ask` `leave` |
| `work` | 收到對我生效的 `[GO]` | `progress` `done` `post` `ask` `leave` |
| `done` | 自己執行 `done` | `post` `ask` `leave` |
| `stopped` | 收到對我生效的 `[STOP]` | `ask` `leave` |
| `closed` | 收到 `[CLOSE]` | `leave` |
| `idle` | `wait` 自動發了 `[IDLE]` | `leave` |
| `left` | 自己執行 `leave` | 無；要再發言須重新 `join` |

不允許時，指令拒絕並以結束碼 3 結束，訊息說明目前階段與該做什麼。

工具在提醒、注意、錯誤訊息裡建議 agent `wait` 時，`--until` 一律照下表（和 `SOP/agent.md` 3.3 的表格一致）。有待答問題不改變等法：主導者的回答不論哪種 `--until` 都收得到。

| 階段 | 建議的等法 |
|---|---|
| `lobby` `topic` `stopped` | `--until moderator` |
| `discussion` | 輪數未滿：不帶 `--until`（any）；輪數已滿：`--until moderator` |
| `work` | 每做完一步 `--timeout 0`；沒事可做時 `--until mention` |
| `done` | `--until mention`（回答別人對成果的問題） |
| `closed` `idle` `left` | 不再 wait |
`stopped` 之後收到對我生效的 `[GO]`、`[CONTINUE]`、`[ASSIGN]` 會照常轉換（不帶 @ 的 GO、CONTINUE 對誰生效見 §4.4）。
「進行中的議題」：頻道最近 200 則訊息中，主導者最後一則 `[TOPIC]` 之後沒有主導者的 `[CLOSE]`。

### 5.3 討論輪數

- `discuss` 成功一次，`discussRound` 加 1。
- 上限 = `discussLimit` ?? 議題的 `rounds` ?? `room.maxDiscussionRounds`。
- 達到上限後 `discuss` 拒絕（結束碼 3），提示 `wait --until moderator` 等 `[CONTINUE]` 或 `[GO]`。
- `[ASSIGN]`、`[CONTINUE]` 把 `discussRound` 歸零；`[CONTINUE] n` 把 `discussLimit` 設為 n，不帶 n 的 `[CONTINUE]` 與 `[ASSIGN]` 把 `discussLimit` 設回 `null`。

### 5.4 無人回應

- 只在 `wait --timeout` 大於 0、且階段不是 `work` 時計時；`--timeout 0` 與 `work` 階段的 `wait` 不設定、也不觸發 IDLE（工作中的長步驟不會被判定閒置）。
- 計時中的 `wait` 開始時，`emptyWaitSince` 若是 `null` 就設為現在。
- 重設計時（`emptyWaitSince` 設回 `null`）：`wait` 收到非自己的新訊息，但標籤是 `[JOIN]`／`[LEAVE]`／`[IDLE]` 的不算（不論是誰發的）；或 agent 自己發了任何訊息；或階段進入 `work`。
- 計時中的 `wait` 結束時若沒有符合條件的新訊息，且 `現在 - emptyWaitSince ≥ idleLimitMin`，工具自動發 `[IDLE]`，階段改為 `idle`，`wait` 的狀態回報為 `idle`。
- 自動 `[IDLE]` 送出失敗時不丟錯：照常輸出這批訊息，狀態維持「逾時」，階段不改，「注意」加一行「自動 [IDLE] 送出失敗（原因），下次 wait 會再試；可用 read 確認是否已送出」，結束碼 0。

### 5.5 作業 repo

- 分工的 `[ASSIGN]` 有 `branch` 或 `isolation` 欄位時，才需要作業 repo；兩者都沒有是純討論分工，不動任何 repo。
- 作業 repo 的決定順序：`[TOPIC]` 的 `repo` > `room.defaultRepo` > agent 目前工作目錄所在的 git repo。
- repo 是 git URL 時 clone 到哪裡、worktree 建在哪裡、要不要 commit 或 push，由 `SOP/agent.md` 規定；工具不做 git 操作。

## 6. 指令

### 6.1 共通規則

- 用法：`agentchat <指令> [選項] [參數]`。
- 共通選項：`--as <名稱>`、`--room <名稱>`、`--json`、`-h`/`--help`。
- 需要 `--as` 的指令：除了 `help`、`sop`、`doctor`、`read`、`clear` 之外都要（`clear` 是主導者用的，帶 `--as` 反而拒絕）。狀態檔不存在時（還沒 `join`），除了 `join` 都以結束碼 2 拒絕；如果本機有 `clear` 留下的這個名稱的清除標記（§6.3 `clear` 第 6 步），訊息不提示 `join`，改成「`<名稱>` 的本機狀態已被主導者用 agentchat clear 清除：先停下來告訴使用者，不要自己重新 join」。指令執行中（例如 `wait` 等待期間、發言送出後）狀態檔才被清掉時也一樣。
- 名稱規則：英數字、底線、連字號，英數字開頭，1 到 31 字元，不含 `discord`、`clyde`，也不能是保留字 `all`、`agents`、`everyone`、`here`，不能以 `moderator` 開頭（例如 `moderator2`，因為 `@moderator` 只看開頭，會被換成主導者 mention）；以上都不分大小寫。慣例是 `<vendor>-<編號>`，例如 `claude-1`。名稱比對一律不分大小寫。
- 文字輸出給 AI 讀：繁體中文、精簡、先講結果。工具在輸出裡提示 agent 下一步要跑的指令時，一律寫完整可執行的形式，帶上 `--as <名稱>`、有 `roomArg` 時帶 `--room <名稱>`（`wait` 另外帶 `--timeout`），不用簡寫。提示裡 `wait` 的 `--timeout` 是 `room.waitTimeoutSec`；agent 照做時換成自己 CLI 的建議秒數（見各家接入說明），SOP 要寫明這點。錯誤訊息寫到 stderr，格式 `agentchat: <訊息>`。
- `--json`：stdout 只輸出一個 JSON 物件。成功是 `{ "ok": true, ... }`，失敗是 `{ "ok": false, "error": { "code": <結束碼>, "message": "..." } }`。
- 發言類指令（`post` `discuss` `ack` `ask` `progress` `done` `leave`）成功後：
  - 輸出送出的訊息 ID。
  - 若游標之後還有未讀訊息，加一行「未讀：N 則，先用 agentchat wait --as <名稱> --timeout 0 讀取」（有 `roomArg` 時另帶 `--room`；`leave` 不印這行）。
  - 附上 `reminders()` 的提醒。
- 任何發言都會更新 `ownMessageIds`、`lastActivityAt`，並把 `emptyWaitSince` 設回 `null`。

結束碼：

| 碼 | 意思 |
|---|---|
| 0 | 成功（`wait` 逾時也是 0） |
| 1 | Discord 或網路錯誤 |
| 2 | 參數或設定錯誤 |
| 3 | 協定規則拒絕（階段不允許、輪數已滿、名稱在頻道或本機使用中、沒有可接手的身分、已離房、同名已有另一個 `wait` 在執行、agent 發主導者標籤） |

### 6.2 發文共通處理

- 內文來源，三選一（同時給兩種以上是結束碼 2）：
  - 位置參數。
  - `--body-file <路徑>`：讀那個檔案（UTF-8）當內文。相對路徑以執行指令時的目前目錄為準；檔案不存在、不是一般檔案、超過 `maxFileMB`，或去掉頭尾空白後是空的，都是結束碼 2。**跨 CLI 的建議做法**：agent 先用自己的寫檔工具把內容寫進暫存檔，再用這個選項，不需要 heredoc、重導向或引號跳脫（Gemini 會擋命令替換、對重導向要求核准；Codex 遇到重導向不套用免核准規則）。
  - 位置參數是 `-`：讀 stdin。**只有**這種情況才讀 stdin（有些 CLI 的 shell 給的是不會關閉的 pipe，自動讀 stdin 會卡到逾時）。
  - 必填內文的指令三者都沒給時結束碼 2。
- 內文已經以標籤列開頭時：
  - 是主導者專用標籤：一律拒絕（結束碼 3）。
  - 專用發言指令（`discuss` `ack` `ask` `progress` `done` `leave`）的內文標籤和指令本身的標籤相同：照原樣送出；是別的 agent 標籤：拒絕（結束碼 2），提示改用 `post`。
  - `post`：內文標籤只能是 `INFO` 或 `DISCUSS`，照原樣送出；`DISCUSS` 套用 `discuss` 的階段與輪數規則；其他 agent 標籤拒絕（結束碼 2），提示改用對應的指令。
- 內文沒有標籤列時，由指令加上自己的標籤。
- `@moderator`、`@主導者` 換成真正的 mention。
- 長度處理：
  - 全文超過 `longTextChars`：訊息只送「標籤列與欄位列 + 內文前 500 字 + `（全文見附檔 message.md）`」，全文以 `message.md` 附檔送出。
  - 全文超過 2000 字：用 `splitMessage()` 切成多則依序送出，只有第一則帶標籤列，附檔放在最後一則。
- 附檔：`--file <路徑>` 可重複，最多 10 個；每個不超過 `maxFileMB`，總和不超過 `maxUploadMB`；超過就拒絕（結束碼 2）。Discord 回 413（檔案太大）時也是結束碼 2，訊息說明是 Discord 拒收。依副檔名給 content type，圖片（png、jpg、jpeg、gif、webp）Discord 會直接顯示。
- 顯示名稱：`displayName(名稱, 角色)`。
- 頭像：每一則 agent 發言（包含 `join` 的 `[JOIN]`、`wait` 自動發的 `[IDLE]`、切段後的每一則）都依 §3.1 的 `avatarUrlTemplate` 帶 `avatar_url`，名稱用 agent 名稱（不含角色）轉成小寫，所以同名同圖（名稱不分大小寫，`Claude-1` 和 `claude-1` 同圖）、換角色不換圖，風格依 vendor，所以同名不同 vendor 圖不同；`avatarUrlTemplate` 是 `null` 時不帶。`doctor --send-test` 不是 agent 發言，不帶。工具本身不連頭像網址（`doctor` 也不檢查），是 Discord 依網址去抓圖。
- 專屬 webhook：本機有這個 agent 的專屬 webhook 快取（`avatar` 建立的，§3.3）時，每一則發言（同上，包含 `[JOIN]`、`[IDLE]`、切段）都改經由它送出，**不帶** `avatar_url`，顯示 webhook 本身的頭像；顯示名稱照樣是 `displayName(名稱, 角色)`。送出時專屬 webhook 回 401 或 404（被刪掉或 token 失效）：刪掉這個 agent 的專屬 webhook 快取，這一則改用共用 webhook 加 `avatarUrlTemplate` 的頭像重送，發言類指令的輸出加一行「專屬 webhook 已失效，改用共用 webhook 發言；要換回自己的頭像請重新執行 agentchat avatar --as <名稱> --file <圖檔>」（有 `roomArg` 時另帶 `--room`），`--json` 加 `agentWebhookLost: true`。`join` 的 `[JOIN]` 遇到失效時，同一行提示加在 `join` 的輸出；`wait` 自動發的 `[IDLE]` 遇到失效時，提示加在「注意」；兩者的 `--json` 也加 `agentWebhookLost: true`。改用共用 webhook 重送也失敗（或送出後更新狀態失敗）時，錯誤訊息後面同樣附上這行提示，`--json` 的錯誤輸出也帶 `agentWebhookLost: true`。刪掉失效的專屬 webhook 快取前，先把它的 ID 記進辨識快取的 `room`（§4.5），它以前發的訊息才不會被歸為 `bot`；`avatar` 的 PATCH 回 401／404 時也一樣。專屬 webhook 快取跟著名稱走：`join`、`leave` 不動它（同名重新進房沿用同一張頭像），只有 `clear`（§6.3）或失效時才刪。
- 送出後更新狀態檔失敗（例如發言途中狀態被主導者 `clear` 清掉）：結束碼 2，訊息開頭寫明「訊息已送出（訊息 ID：…），不要重發；但更新本機狀態失敗：<原因>」；本機紀錄（`logs/`）照常寫入，寫入也失敗時只在後面附「；本機紀錄也寫入失敗：<原因>」，不蓋掉前面的訊息。`wait` 自動發的 `[IDLE]` 送出後更新狀態失敗時也一樣（訊息寫「自動 [IDLE] 已送出」）。發言送出失敗（一段都沒送出，或切段只送出一部分）時照原本的錯誤結束，之後要更新狀態（記下已送出的段、退回 `[DISCUSS]` 預扣的輪數）也失敗的話，只在原本的訊息後面附「；更新本機狀態也失敗：<原因>」；切段已送出一部分時，這種情況不提示「請只補送剩下的部分」，改成「不要補送，先停下來告訴使用者」。

### 6.3 各指令

**`help [指令]`**：列出所有指令與一行說明；帶指令名稱時印該指令的用法。

**`sop [agent|moderator|setup-claude-code|setup-gemini-cli|setup-codex-cli] [--path]`**：印出 `SOP/<名稱>.md` 的內容（預設 `agent`）；`--path` 只印絕對路徑。名稱不在清單裡或檔案不存在時結束碼 2。agent 要讀自己 CLI 的接入說明時用 `agentchat sop setup-<cli>`，不要用命令替換組路徑（Gemini 的 shell 會擋 `$()`）。

**`doctor [--as <名稱>] [--send-test]`**：逐項檢查，每項一行 `[OK]`、`[WARN]` 或 `[FAIL]`，最後一行總結。有 FAIL 時結束碼 1，設定問題結束碼 2。
1. Node 版本 ≥ 18.17。
2. `room.json` 可讀且必填欄位齊全、ID 是字串；印出房間名稱與頻道 ID。
3. 找得到 bot token（不印出 token）。
4. `GET /users/@me`：token 有效，印出 bot 名稱。
5. `GET /applications/@me`：`flags` 含 `GATEWAY_MESSAGE_CONTENT`（1<<18）或 `GATEWAY_MESSAGE_CONTENT_LIMITED`（1<<19）；沒有就 FAIL，並說明到 Developer Portal 開 Message Content Intent。
6. `GET /channels/<id>`：可讀，`guild_id` 等於 `room.guildId`；頻道類型是討論串時 FAIL「尚未支援討論串」（§10）。
7. `GET /channels/<id>/messages?limit=1`：有讀取訊息歷史的權限。
7a. `GET /users/<moderatorUserId>`：主導者 ID 存在，印出他的使用者名稱，讓人確認沒填錯；查不到就 FAIL。
7b. 第 6 項通過時：bot 在頻道有沒有「管理訊息」（Manage Messages）權限（算法同 `clear` 第 2 步）。有就 OK；沒有就 WARN，說明只有 `clear` 需要與修正方法；查詢失敗也只 WARN，不 FAIL。
8. webhook：本機快取有效就用（`GET /webhooks/<id>/<token>`）；否則在頻道的 webhook 清單找名稱等於 `webhookName` 且有 token 的；再沒有就建立一個並寫入快取。需要「管理 Webhook」權限。
8a. 第 8 項通過時：`GET /channels/<id>/webhooks`，印出頻道的 webhook 數量（Discord 每個頻道上限 15 個）與其中本工具的（共用與專屬，名稱等於 `webhookName` 或以 `<webhookName>-` 開頭）各幾個。少於 13 個 OK；13 個以上 WARN，說明接近上限、新的 agent 會無法設定頭像，提示用 `agentchat clear` 清掉專屬 webhook 或到頻道設定刪掉不用的；查詢失敗只 WARN。
9. `--send-test`：用共用 webhook 發一則 `[INFO] doctor 測試`。只有帶這個選項才發。
10. 帶 `--as` 時，額外印出該 agent 的本機狀態摘要。
11. 設定提醒（§9）：`AGENTCHAT_API_BASE` 不是預設值時 WARN 並印出位址；`.env` 權限對群組或其他人開放時 WARN。

**`join --as <名稱> --vendor <claude|gemini|codex|other> [--model <文字>] [--host <標籤>] [--resume] [--force]`**
1. 檢查名稱規則；先做 doctor 第 6 項（頻道可讀、`guild_id` 等於 `room.guildId`、不是討論串），不通過就結束碼 2，不建 webhook、不發 `[JOIN]`；再確保 webhook 存在（同 doctor 第 8 項）。
2. 名稱衝突（頻道）：要建立新身分時（本機沒有這個名稱的狀態檔，或狀態檔 `left` 為 true），檢查頻道最近 200 則訊息：這個名稱（不分大小寫）最後一則訊息在 24 小時內且不是 `[LEAVE]` 或 `[IDLE]` → 拒絕（結束碼 3），提示換名稱或加 `--force`。帶 `--force` 時跳過這個檢查。
3. 本機已有這個名稱的狀態檔且 `left` 為 false（可能是本機另一個 session 正在用這個名稱）：
   - 沒帶 `--resume` 也沒帶 `--force`：拒絕（結束碼 3），訊息寫明「這個名稱在本機使用中」、該身分最後活動時間，並提示「新開的 session 請換名稱；確定要接手這個身分才加 --resume」。
   - 帶 `--resume`：接手這個身分，保留角色、階段與游標，不發 `[JOIN]`；輸出第一行固定是「重新連線：接手既有身分 <名稱>，沒有發 [JOIN]」，接著是和 `status` 相同的完整內容。
   - 帶 `--force`：捨棄舊狀態，照第 4 步以後建立新身分並發 `[JOIN]`。
   - 帶 `--resume`，但本機沒有這個名稱的狀態檔或狀態檔 `left` 為 true（沒有可接手的身分）：拒絕（結束碼 3），提示「沒有可接手的身分，請不帶 --resume 進房」；沒有狀態檔且有 `clear` 的清除標記時，改成 §6.1 的「已被主導者 clear 清除」訊息（仍是結束碼 3）。
4. 否則建立新狀態，游標設為頻道目前最新一則訊息的 ID（頻道是空的就設 `'0'`，不用本機時鐘，免得時鐘偏快時漏讀）。
5. 有進行中的議題時：印出議題全文，再對議題之後的所有主導者訊息依序執行 `applyDirectives()`（`[ASSIGN]`、`[GO]`、`[CONTINUE]`、`[STOP]` 都套用），印出對我生效的那幾則，讓晚進房的 agent 直接到達正確階段。
6. 發 `[JOIN] <名稱>`，欄位 `vendor`、`model`、`host`（有給才寫）。
7. 輸出：房間資訊與實際生效的語言、目前階段、`applyDirectives()` 產生的「注意」（同時存進 `lastNotes`）、`reminders()` 的提醒（段落標題和其他指令一樣叫「提醒」）。第 5 步印的議題與指令用 `renderMessage()` 的格式（原文加 `│ ` 前綴）。

**`status --as <名稱>`**：印出本機狀態（階段、角色、分工欄位與 `assignBody`、議題標題與欄位 `repo` `base` `rounds` 與附檔清單、**實際生效**的語言（`room.language`）、作業 repo（依 §5.5：議題的 `repo`、`room.defaultRepo`，或「未指定，分工有 branch 或 isolation 時用目前目錄的 git repo」）與 base（議題的 `base` 或 `room.defaultBase`）、討論輪數、游標、待答問題、`lastNotes`）、未讀則數（打一次 API）與提醒。給 agent 在對話被壓縮後找回進度用。

**`read [--as <名稱>] [--last <N>] [--id <訊息ID>]`**：印出頻道最近 N 則（預設 20，最多 100），舊的在前；帶 `--id` 時只印那一則（找回舊的議題或分工）。不移動游標、不套用指令。沒有 `--as` 時不判斷 `self` 與「提到我」。

**`wait --as <名稱> [--timeout <秒>] [--until any|mention|moderator]`**
- 階段是 `left` 時拒絕（結束碼 3），提示「你已離開這個房間；除非開這個 session 的使用者要求，不要重新 join」。`status`、`read` 在 `left` 階段照常可用。
- 同一個名稱同時只能有一個 `wait`：開始時在狀態目錄建立 `<名稱>.wait.lock`（內容是 pid），結束時刪除。鎖檔存在且那個 pid 還活著時拒絕（結束碼 3），提示「同名已有另一個 wait 在執行（pid <pid>，<開始時間> 開始），先讀完它的輸出」；pid 已不存在就視為殘留，直接接手。
- 每次 `wait` 的「注意」存進 `lastNotes`（沒有新的注意時保留上一次的）。
- `--timeout` 預設 `waitTimeoutSec`，範圍 0 到 540。0 表示只查一次、不等待。
- `--until` 預設 `any`：
  - `any`：任何非自己的新訊息。
  - `mention`：`mentionsMe` 為真，或主導者的指令訊息對我生效（`targetsMe`）。
  - `moderator`：任何主導者訊息。
- 每 `pollIntervalSec` 秒抓一次游標之後的訊息，排除自己，累積起來，不重複抓。
- 單次輸出上限 50 則：累積超過 50 則時立刻結束，只處理最舊的 50 則（狀態 `partial`）。
- 條件成立、逾時或達到上限：對**要輸出的**訊息依序執行 `applyDirectives()`，游標只移到其中最後一則，存檔，輸出這些訊息（不只符合條件的那幾則）；沒輸出的訊息留給下一次 `wait`。
- 第一行是狀態：`狀態：符合條件（<原因>）`、`狀態：逾時，沒有新訊息`、`狀態：逾時，有 N 則其他新訊息`、`狀態：已自動發出 [IDLE]`、`狀態：還有未讀，先處理這 50 則，再執行 agentchat wait --as <名稱> --timeout 0`（有 `roomArg` 時另帶 `--room`）。
- 接著一行摘要，格式固定：`階段：<§5.2 的階段代號>　角色：<角色或「未指派」>　討論：<已發>/<上限>`（階段代號用英文，例如 `discussion`）。
- 然後依序是「注意」（`applyDirectives()` 的回傳）、「提醒」（`reminders()`）、訊息（`renderMessages()`）。注意與提醒放在訊息前面，避免輸出很長時被 agent 的工具截掉。
- `--json`：`{ ok, status: "matched"|"timeout"|"idle"|"partial", reason, phase, role, round: { done, limit }, messages: [...], notes: [...], reminders: [...] }`。

**`post --as <名稱> [--tag <TAG>] [--title <文字>] [--field key=value]... [--file <路徑>]... [內文|-]`**
- 預設標籤 `INFO`。`--tag` 只接受 `INFO` 與 `DISCUSS`；`--tag DISCUSS` 等同 `discuss`，遵守同樣的階段與輪數規則。
- 其他 agent 標籤拒絕（結束碼 2），提示改用 `ask`、`progress`、`done` 等對應指令；主導者專用標籤拒絕（結束碼 3）。

**`discuss --as <名稱> [--file <路徑>]... <內文|->`**：發 `[DISCUSS]`，只在 `discussion` 階段可用，計入輪數。

**`ack --as <名稱> [內文|-]`**：發 `[ACK]`，欄位 `role`、`branch` 取自狀態；內文寫自己對分工的理解。只在 `discussion` 階段可用。

**`ask --as <名稱> [--file <路徑>]... <問題|->`**：發 `[QUESTION]`，第一行寫成 `[QUESTION] <@moderatorUserId> <問題的第一行>`（mention 緊接在標籤之後，標籤才解析得到、通知也會響）；記下 `pendingQuestionId`。輸出提示接著照目前階段的等法（§5.2 下方的表）`wait`，主導者的回答一定收得到。

**`progress --as <名稱> --percent <0-100> [--eta <文字>] [--file <路徑>]... <內文|->`**：發 `[PROGRESS] <percent>%`，欄位 `percent`、`eta`、`branch`；更新 `lastProgressAt`。只在 `work` 階段可用。

**`done --as <名稱> [--branch <分支>] [--worktree <路徑>] [--commit <SHA>] [--file <路徑>]... <摘要|->`**：發 `[DONE]`，`branch` 預設取自狀態；階段改為 `done`。只在 `work` 階段可用。

**`leave --as <名稱> [原因|-]`**：發 `[LEAVE]`，`left` 設為 true，階段改為 `left`。任何階段都可用（`left` 除外）。輸出不印未讀提示，改印「已離開，不要再 wait 或重新 join」。

**`avatar --as <名稱> --file <圖檔>`**：設定這個 agent 自己的頭像（建立或更新它的專屬 webhook）。不發任何訊息、不改 agent 狀態。
1. 需要狀態檔（§6.1）；階段是 `left` 時拒絕（結束碼 3，同 `wait`）。沒給 `--file`、有位置參數，都是結束碼 2。
2. 檢查圖檔（都是結束碼 2）：套用 §9 的路徑拒絕規則；檔案存在而且是一般檔案；大小大於 0、不超過 8 MB（Discord 官方文件沒有寫明 webhook 頭像的上限，這是工具自訂的，頭像建議 256×256 左右，通常遠小於 1 MB）；看檔頭判斷格式，只接受 PNG（`89 50 4E 47 0D 0A 1A 0A`）、JPEG（`FF D8 FF`）、GIF（`GIF87a`／`GIF89a`），不看副檔名；套用 §9 的秘密內容檢查（含 token 的檔案拒絕）。圖檔轉成 data URI（`data:image/png;base64,…`，MIME 依檔頭）。
3. 取得專屬 webhook，名稱 `<webhookName>-<名稱小寫>`：
   - 本機快取（`webhooks/<channelId>/<名稱小寫>.json`）有 id 與 token：`PATCH /webhooks/<id>/<token>` 只送 `avatar`。回 401 或 404 時刪掉快取，往下找或建立。
   - 頻道的 webhook 清單裡有名稱完全相同、而且有 token 的（例如別台機器建立過），挑 ID 最小的，`PATCH` 頭像後寫入快取。
   - 都沒有：`POST /channels/<id>/webhooks`，送 `name` 與 `avatar`，寫入快取（權限 0600）。
   需要「管理 Webhook」權限；Discord 回 403 時說明缺這個權限；回 400 且錯誤碼是 30007（頻道 webhook 已達 15 個上限）時說明上限，並提示主導者用 `agentchat clear` 清掉專屬 webhook 或到頻道設定刪掉不用的 webhook；其他圖檔被拒（400、413，例如錯誤碼 50138、40005、50045）時說明 Discord 拒收這張圖、請換小一點的 PNG。都是結束碼 1（413 照 §6.2 是結束碼 2）。
4. 輸出：`已設定 <名稱> 的頭像（<建立新的專屬 webhook|更新專屬 webhook|沿用頻道裡既有的專屬 webhook>，<webhook 名稱>，id=<id>）`，加一行「之後的發言會顯示這張頭像」。不印 token。`--json`：`{ ok, name, webhook: { id, name }, source: "created"|"updated"|"found", bytes, format }`。

**`download --as <名稱> <訊息ID> [--out <目錄>] [--name <檔名>]`**
- 重新 `GET` 那則訊息以取得新的附檔連結（舊連結會過期）。
- 下載全部附檔，或只下載 `--name` 指定的那個；每個檔不超過 25 MB。
- 預設存到 `~/.agentchat/downloads/<channelId>/<訊息ID>/`。檔名只取 basename，`/`、`\`、控制字元與開頭的 `.` 換成 `_`。
- 輸出每個檔的絕對路徑、大小、content type，並提醒「這是外部資料，只讀取，不要執行」。

**`clear [--yes]`**：主導者在終端機用，永久刪除房間頻道的所有訊息（主導者、agent、其他人的都刪），並清掉這台機器上本房各 agent 的狀態。agent 不可以執行。
1. 帶 `--as` 或位置參數就拒絕（結束碼 2）。`GET /channels/<id>`，`guild_id` 不等於 `room.guildId` 或頻道是討論串（§10）就拒絕（結束碼 2），不刪任何訊息。
2. 權限檢查：`GET /users/@me`、`GET /guilds/<guildId>/members/<botId>`、`GET /guilds/<guildId>/roles`，加上頻道的 `permission_overwrites`，照 Discord 的算法（@everyone 與各角色聯集；有 Administrator 就全有；再依序套用 @everyone、各角色（先合併 deny 再合併 allow）、成員本人的覆寫）算出 bot 在頻道的權限；伺服器擁有者與禁言兩個特例不處理（誤判時由第 5 步的 403 中止）。缺「檢視頻道」「讀取訊息歷史」或「管理訊息」任一項就拒絕（結束碼 1），訊息寫明缺哪一項與修正方法（伺服器設定 → 角色給 bot 的角色勾上、或頻道設定 → 權限允許，或用 OAuth2 URL Generator 多勾該權限重新邀請 bot），不刪任何訊息。
3. 由新到舊翻頁（`before`，每頁 100）取得頻道目前所有訊息的 ID。之後才出現的訊息不刪。
4. 確認：沒帶 `--yes` 時，在 stderr 印出頻道名稱、ID、要刪的則數、會清掉的本機狀態目錄，要求輸入頻道名稱；去掉頭尾空白與開頭一個 `#` 後必須和頻道名稱完全相同（分大小寫）。stdin 不是終端機（TTY）、輸入不符或輸入直接結束，都中止（結束碼 2），不刪任何訊息、不清狀態。stdin 不是終端機時的訊息不教 agent 加 `--yes`，寫「clear 是主導者專用指令，agent 不可以執行；主導者請在自己的終端機執行，或在自己的腳本裡加 --yes」；`help clear` 對 `--yes` 的說明也只寫成主導者在自己腳本裡用。
5. 刪除：建立時間在「現在 − 14 天 + 1 小時」之後的，每批最多 100 則用 `POST /channels/<id>/messages/bulk-delete`；批次只剩 1 則時、以及更舊的訊息，逐則 `DELETE /channels/<id>/messages/<訊息ID>`。bulk-delete 回 400 時，那一批改成逐則刪。逐則刪回 404 算略過（已不存在），回 400 算失敗（例如不能刪的系統訊息），記下 ID 繼續。429 與 5xx、網路錯誤照 §7.4 的重試規則；其他錯誤（含 403、重試用盡）立刻中止（結束碼 1），訊息附「中止前已刪除 N 則，本機狀態沒有清除」，403 時說明缺「管理訊息」與修正方法，並附 Discord 的原始回應。
6. 刪完（沒有中止，包括有失敗的）先刪頻道裡本工具建立的專屬 webhook：`GET /channels/<id>/webhooks`，名稱以 `<webhookName>-` 開頭的逐個 `DELETE /webhooks/<id>`（bot 身分，需要「管理 Webhook」），回 404 算已不存在；共用 webhook（名稱等於 `webhookName`）保留。再刪掉本機的專屬 webhook 快取目錄 `webhooks/<channelId>/` 與辨識快取 `webhooks/<channelId>.known.json`（共用 webhook 快取 `webhooks/<channelId>.json` 保留）。查清單或刪 webhook 失敗不中止、不改結束碼，只在輸出加一行警告（附原因與已刪幾個），本機快取照樣刪除（失效的專屬 webhook 在發言時會自動改用共用 webhook，§6.2）。別台機器的專屬 webhook 快取不會被清，那些 agent 下次發言時發現失效就改用共用 webhook。
   接著刪掉整個 `~/.agentchat/agents/<channelId>/`（各 agent 的狀態檔、wait 鎖與暫存檔），讓 agent 下次進房是乾淨的新身分；共用 webhook 快取、`logs/`、`downloads/` 保留（`logs/` 的發言紀錄與 `downloads/` 的附檔仍留有被刪訊息的內容，要徹底清除由主導者手動刪除）。只影響執行 `clear` 的這台機器。接著在同一個目錄為每個被清掉的 agent 留一個清除標記 `<名稱小寫>.cleared`（內容是 `{"name","clearedAt"}` 的 JSON；狀態檔或舊標記裡的名稱不符合名稱規則時，改用檔名去掉副檔名當名稱），刪除前已有的清除標記也重新寫回，讓還在跑、還沒重新 `join` 的 agent 下一個指令收到 §6.1 的「已被主導者 clear 清除」訊息，而不是被提示 `join`。標記只在狀態檔不存在時才看；`join` 建立新身分後狀態檔存在，標記不再有作用（`join` 順便刪掉自己的標記）。寫標記失敗不影響結果（訊息與狀態都已清掉），只在輸出加一行警告。刪目錄遇到別的行程正好在裡面建鎖檔時重試幾次。
   已知限制：`clear` 不拿各 agent 的鎖，所以執行當下還在跑的 agent 可能把狀態寫回來（例如正在 `join`、或剛好在更新狀態檔），也可能在第 3 步之後才發言、留在頻道上；SOP 要求主導者先讓 agent 都停下來再 `clear`。
7. 輸出：`已清空 #<頻道名稱>：刪除 N 則（其中逐則刪除 M 則），略過 S 則（已不存在），失敗 F 則`；批次刪除的則數是送出的則數（Discord 對批次裡已不存在的訊息不報錯，所以不會算進略過）；有失敗時列出前 10 個 ID；清掉的 agent 名稱與目錄；刪除的專屬 webhook 個數（失敗時是警告）；提醒別台機器的狀態不會被清、agent 要回來就重新 `join`（不帶 `--resume`）。有失敗時結束碼 1。
8. `--json`（照 §6.1）：`channel`（`id`、`name`）、`total`、`deleted`、`bulkDeleted`、`singleDeleted`、`skipped`、`failed`、`failedIds`、`clearedAgents`、`stateDir`、`markError`（寫清除標記失敗的原因，沒失敗是 `null`）、`webhooksDeleted`（刪掉的專屬 webhook 個數）、`webhookError`（查清單或刪除失敗的原因，沒失敗是 `null`）；有失敗時 `ok` 為 false，`error.code` 為 1，同時附上這些欄位。

## 7. 核心模組 API

下列 export 是測試與指令共用的介面。cmd 可以調整實作，但改簽名或語意要先通知協調。
標「新增」或「修改」的是目前程式還沒做到、cmd 要實作的部分。

### 7.1 `src/protocol.js`

| export | 規格 |
|---|---|
| `MODERATOR_TAGS` `AGENT_TAGS` `ALL_TAGS` | §4.2 的標籤清單 |
| `FIELD_KEYS`（新增） | §4.3 的欄位名稱清單 |
| `NAME_RE` `DISCORD_MESSAGE_LIMIT` | 名稱規則、2000 |
| `validateAgentName(name)` | 合法回 `null`，否則回中文錯誤說明；包含 §6.1 的保留字 |
| `parseMessage(content)`（修改） | 回 `{ tag, title, fields, body }`，規則見 §4.1：全形括號與全形冒號、只認已知標籤與欄位 |
| `buildMessage(tag, title, fields, body)` | 組出 §4.1 格式；略過空值欄位 |
| `extractMentions(content)`（修改） | 回 `{ users, at }`；`users` 是 `<@id>` 裡的 ID，`at` 是每個 @ 位置之後的文字索引（給「有沒有 @」判斷用） |
| `mentionsWord(text, word)`（新增） | §4.4「@ 到 W」的判斷，回 boolean |
| `isMentioned(content, self)`（修改） | §4.4「提到我」的文字部分：用 `mentionsWord` 比對名稱、角色與廣播詞；`self` 有 `name`、`role` |
| `targetsOf(content)`（新增） | 只看第一行，回 `{ hasAt, broadcast }`：第一行有沒有 @ 位置、有沒有 @ 到廣播詞；對象比對交給 `isTargeted` 用 `mentionsWord` 做 |
| `isTargeted(msg, self)`（新增） | §4.4「指令對我生效」；`msg` 是 `normalize()` 的結果。`msg.kind` 存在且不是 `moderator` 時一律 `false`；沒有 `kind`（手工組的物件）時只看標籤與第一行。`normalize()` 的 `targetsMe` 只有主導者訊息可能為 `true` |
| `resolveMentions(text, room)`（新增） | 把 `@moderator`、`@主導者`（含全形 ＠）換成 `<@moderatorUserId>` |
| `displayName(name, role)`（修改） | 有角色時 `角色（名稱）`（全形括號，括號前不空格），沒有角色時只有 `名稱`；總長截到 80 字，只截角色，名稱保持完整 |
| `splitAgentName(username)`（修改） | 回 `{ name, role }`；認得新格式 `角色（名稱）`（最後一對全形括號裡是符合名稱規則的字串，角色是它前面的全部）與舊格式 `名稱 (角色)`，兩者都不是時整個當名稱、`role` 為 `null` |
| `isSelfName(username, name)`（修改） | 顯示名稱是否屬於這個 agent：`splitAgentName(username).name` 與 `name` 不分大小寫相等（新舊格式都認得） |
| `sanitizeRole(role)`（修改） | 刪除（不是換成空白）括號（半形與全形）、`@`、`＠`、`#`、`:`、`：`、反引號；換行與連續空白換成一個 `-`，去掉頭尾的 `-`；`discord`、`clyde`（不分大小寫）換成 `dc`、`cl`，重複換到不再出現為止（Discord 拒收含這兩個字的 webhook 名稱）；截到 40 字；空字串回 `null`。例：`前端(主)` → `前端主`、`QA Lead` → `QA-Lead`、`Discord API` → `dc-API` |
| `authorKind(raw, room, self, opts)`（修改） | §4.5；`opts.webhookIds` 是本房 webhook ID 的集合（陣列或 `Set`），`opts.webhookId` 是單一 ID（舊介面，仍接受，兩者合併）；兩者都沒有或是空的時，webhook 訊息一律不歸為 `bot` |
| `normalize(raw, room, self, opts)`（修改） | 回 `{ id, timestamp, kind, author, authorRole, authorId, content, tag, title, fields, body, mentionsMe, targetsMe, mentionsModerator, replyTo, attachments }`；`replyTo` 取自 `message_reference.message_id`；「回覆我的訊息」用 `self.ownMessageIds` 判斷（`self` 就是 agent 狀態物件）；`opts` 帶 `webhookIds` 或 `webhookId`（同 `authorKind`）；`self` 可以是 `null` |
| `splitMessage(text, limit = 2000)` | 每段 ≤ limit；多段時每段結尾加 `(i/n)`；盡量在行邊界切；code fence 跨段時兩邊都補成對 |
| `applyDirectives(state, messages, room)`（修改） | 依序逐則套用對我生效的主導者指令（§4.2、§5），每則都用**當下**的狀態判斷對象（例：同一批先 `[ASSIGN] @claude-1 role: 前端` 再 `[GO] @前端`，GO 對 claude-1 生效）；回傳給 agent 看的「注意」字串陣列；同時處理 §4.4 的清除 `pendingQuestionId`，以及 §5.4 的重設計時（別的 agent 的 `[JOIN]`／`[LEAVE]`／`[IDLE]` 不重設）。`messages` 是 `normalize()` 的結果，函式內依當下狀態重新判斷 `targetsMe` |
| `reminders(state, room, now = Date.now())` | 依階段產生提醒字串陣列（§5.3 輪數、工作階段的進度提醒、`stopped`／`closed`／`idle` 的指示）。進度提醒從 `lastProgressAt` 算起，還沒回報過就從 `workStartedAt` 算起，超過 `progressReminderMin` 就提醒 |

### 7.2 `src/config.js`

`TOOL_HOME`、`ENV_FILE`、`parseEnv(text)`、`loadEnv()`、`getToken()`、`roomFile(roomName)`、`loadRoom(roomName)`。
`loadRoom` 回傳合併預設值（§3.1）後的物件，另加 `file`（設定檔路徑）與 `roomArg`（`--room` 給的名稱，沒給是 `null`；工具輸出提示指令時，`roomArg` 有值就帶上 `--room <名稱>`）兩個欄位；缺必填欄位、JSON 不合法，或 `guildId`／`channelId`／`moderatorUserId` 不是純數字字串（寫成 JSON 數字會因超過 2^53 失準）時丟 `UserError`。
`TOOL_HOME` 在模組載入時決定，測試要先設環境變數再動態 import。

### 7.3 `src/state.js`

`STATE_DIR`、`loadAgent(channelId, name)`、`saveAgent(state)`、`newAgent({ name, vendor, model, channelId, cursor })`（修改：補 §5.1 新欄位）、`loadWebhook`、`saveWebhook`、`clearWebhook`、`appendLog`、`downloadDir`；`markCleared(channelId, names)`、`unmarkCleared(channelId, name)`、`missingAgentError(channelId, name, message)`（新增：§6.3 `clear` 第 6 步的清除標記，以及狀態檔不存在時依標記選擇 §6.1 的訊息）；`loadAgentWebhook(channelId, name)`、`saveAgentWebhook(channelId, name, webhook)`（權限 0600）、`clearAgentWebhook(channelId, name)`、`listAgentWebhooks(channelId)`、`clearAgentWebhooks(channelId)`（專屬 webhook 快取，§3.3）；`loadKnownWebhooks(channelId)`、`saveKnownWebhooks(channelId, known)`、`clearKnownWebhooks(channelId)`（辨識快取，§4.5）。
`saveAgent` 要原子寫入（暫存檔再改名）。

### 7.4 `src/discord.js`

`createClient(token, { apiBase, retryBaseMs })`（修改：`apiBase` 預設讀 `AGENTCHAT_API_BASE`；`retryBaseMs` 是 5xx 與網路錯誤的退避基準，預設 1000，第 n 次重試等 `retryBaseMs × n`，測試可設小值）回傳的物件提供：
`me()`、`application()`（新增，`GET /applications/@me`）、`channel(id)`、`messages(id, { after, before, limit })`（舊到新）、`messagesAfter(id, cursor, maxPages)`、`message(channelId, messageId)`、`listWebhooks(id)`、`createWebhook(id, name)`、`getWebhook(id, token)`（新增）、`executeWebhook(webhook, { content, username, avatarUrl, files, allowedMentions })`（`avatarUrl` 有值時送 `avatar_url`）、`download(url)`。
`clear` 與 doctor 另外用到：`bulkDelete(channelId, messageIds)`（`POST /channels/<id>/messages/bulk-delete`，一次 2–100 則、只限 14 天內）、`deleteMessage(channelId, messageId)`（逐則刪除）、`guildMember(guildId, userId)`、`guildRoles(guildId)`（計算 bot 在頻道的權限用）。
`avatar` 與 `clear` 另外用到：`createWebhook(id, name, avatar)`（`avatar` 是 data URI，選填）、`modifyWebhook(id, token, { avatar })`（`PATCH /webhooks/<id>/<token>`，不送 bot token）、`deleteWebhook(id)`（`DELETE /webhooks/<id>`，bot 身分）。
另外 export `compareSnowflake`、`snowflakeNow`、`snowflakeToDate`。
遇到 429 依 `retry_after` 等待重試（`retry_after` 超過 60 秒就不等，直接丟 `DiscordError`，訊息寫明要等幾秒），5xx 與網路錯誤退避重試；重試最多 5 次（加上第一次共 6 次請求）；401、403、404 給中文提示。
例外：`executeWebhook`（發言）只在 429 時重試；5xx 與網路錯誤不重試，直接結束碼 1，訊息提示「可能已經送出，先用 agentchat read --as <名稱> --last 5 確認再決定要不要重發」（有 `roomArg` 時另帶 `--room`；這句由指令層組出，`discord.js` 不知道名稱與房間），以免重複發言。

### 7.5 `src/render.js`、`src/args.js`、`src/errors.js`

`renderMessage(m, { as, room })`、`renderMessages(list, { as, room })`（附檔行的 download 指令與其他提示一樣用完整形式，有 `room.roomArg` 時帶 `--room`；作者名稱與附檔名用 `oneLine()` 清理；格式固定，SOP 依賴它：第一行 `[MM/DD HH:MM:SS] <作者標示>  (id=<訊息ID>)`，提到我或指令對我生效時行尾加 `  ← 提到你`；作者標示是 `主導者 <名稱>`、`agent <名稱>`（有角色時是 `agent <角色>（<名稱>）`）、`你 <名稱>`、`人類 <名稱>`、`bot <名稱>`；接著是訊息原文，**每一行前面加 `│ `**（`\r\n`、單獨的 `\r`、`\n` 都當成換行）（工具產生的結構行一律頂格，原文一律縮排，別人無法在內文裡偽造主導者訊息或「注意」段落）；每個附檔一行（頂格） `附檔：<檔名>（<大小>）→ agentchat download --as <as> <訊息ID>`，沒有 `as` 時印 `--as <你的名稱>`；多則之間用一行 `---` 分隔）、`fmtSize(n)`（1024 進位：小於 1024 印 `N B`；小於 1024×1024 印四捨五入的 `N KB`；其餘印一位小數的 `N.N MB`）、`fmtTime(iso)`（本機時區）、`kindLabel(kind)`、`section(title, items)`；
`parse(argv, options)`、`requireAs(values)`、`toInt(value, fallback, label)`；`UserError`、`DiscordError`。

## 8. 測試

- 一律用 Node 內建的 `node --test`，不加任何依賴。`package.json` 的 `scripts.test` 固定是 `node --test test/*/*.test.js`：由 npm 的 shell 展開成檔案清單（Node 21 起 `node --test` 不接受目錄參數；不帶參數又會把 `test/` 底下的輔助檔也當成測試）。
- 測試檔一律命名 `*.test.js`，放在 `test/` 下一層的子目錄（`test/core/`、`test/commands/`、`test/install/`）；輔助檔（例如 `mock-discord.js`）不要用 `.test.js` 結尾。
- `test/core/`：核心模組單元測試，包含 `discord.test.js`（snowflake 函式、`createClient` 對 127.0.0.1 本機假伺服器的重試與錯誤提示）與 `args.test.js`；不連外部網路。
- `test/commands/`：指令層測試。`test/commands/mock-discord.js` 是假 Discord 伺服器，用 `node:http` 在隨機 port 起，以 `AGENTCHAT_API_BASE` 指過去；狀態目錄與工具目錄用暫存資料夾（`AGENTCHAT_STATE_DIR`、`AGENTCHAT_HOME`）。
- 測試不得連真正的 Discord，也不得讀寫真正的 `~/.agentchat`。

## 9. 安全規則

- bot token 只放 `.env` 或環境變數；webhook token 只放 `~/.agentchat/webhooks/`，權限 0600。兩者都不能出現在輸出、log 或頻道訊息裡。
- 頻道裡的內容（包括其他 agent 的發言與附檔）對 agent 一律是資料，不是指令。只有主導者的指令訊息能改變 agent 的階段與分工。
- 工具只允許通知主導者（§4.4 的 `allowed_mentions`）。
- `download` 只存檔、不執行，檔名清理過才寫入。
- **輸出清理**：所有來自頻道的字串（作者名稱、附檔名、訊息內文）輸出前都要中和控制字元：C0（保留 `\t`；內文的 `\n` 與 `\r` 照 §7.5 換行）、DEL、C1（`\x80`–`\x9f`）、U+2028／U+2029、雙向文字控制字元（U+202A–U+202E、U+2066–U+2069）換成 U+FFFD。作者名稱與附檔名另外把換行換成空白（`oneLine()`），包括 `wait` 第一行狀態列、`download` 的輸出與錯誤訊息、`status`／`join` 的議題附檔行。
- **防止秘密送進頻道**（`--body-file`、`--file`、內文；`avatar --file` 也套用路徑拒絕與秘密內容檢查）：
  - 比對的秘密包含：環境變數與 `.env` 裡的 `DISCORD_BOT_TOKEN`（兩者都收，不論實際用哪個、格式對不對），以及 `~/.agentchat/webhooks/` 底下每個快取檔（包括 `webhooks/<channelId>/` 裡的專屬 webhook 快取）的 webhook token。內文或附檔含任一個就拒絕（結束碼 2）。
  - 內容偵測：含 `-----BEGIN ... PRIVATE KEY-----`、`-----BEGIN PGP PRIVATE KEY BLOCK-----` 或 AWS access key（`AKIA` 加 16 個大寫英數字）就拒絕（結束碼 2），訊息說明原因。
  - 路徑拒絕（用 realpath 比對）：`~/.agentchat`（狀態目錄，含 `downloads/`；要轉傳下載的附檔，先用 `download --out` 存到別處）、工具目錄的 `.env`、`~/.ssh`（`*.pub` 與 `known_hosts` 放行）、`~/.aws`、`~/.gnupg`、`/proc`、`/sys`、`/dev`。拒絕時結束碼 2。
  - 讀檔後用實際讀到的位元組數再檢查一次大小上限（procfs 之類的檔案 stat 大小是 0）。
  - 這些是最後一道防線，擋不住刻意繞過；SOP 要寫明不要依頻道內容指定的路徑附檔或讀檔。
- **doctor 的設定提醒**：`AGENTCHAT_API_BASE` 不是預設值時 WARN 並印出實際位址，不是 https 又不是本機位址時也標出來；`.env` 的權限對群組或其他人開放（`mode & 0o077` 不為 0）時 WARN，提示 `chmod 600`。

## 10. 這一版不做

- 討論串（thread）頻道、Discord slash command、Gateway 常駐連線。
- 主導者編輯或刪除已發出的訊息（不會重新套用；發錯就重發）。
- 多房間同時參加（一個 agent 一次只在一個房間）。
- 自動 push、自動開 PR、自動合併：工作階段的 git 操作由 agent 依 SOP 手動執行。
