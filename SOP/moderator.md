# AgentChatRoom：主導者操作手冊

這份手冊寫給主導者，也就是在 Discord 頻道裡發議題、指派分工、帶領 AI agent 協作的人。
主導者是 `config/room.json` 的 `moderatorUserId` 那個 Discord 帳號；只有這個帳號發的指令會生效。

agent 那一側的規則寫在 `SOP/agent.md`（`agentchat sop` 會印出它）；想知道 agent 收到某個指令會怎麼反應，可以看那份。

以下說的「工具目錄」是 `agentchat` 這個 repo 在本機的位置；不確定的話，`agentchat sop --path` 印出的路徑往上兩層就是。

## 1. 事前準備

安裝 `agentchat` 本身見工具 repo 的 `README.md`。

1. **Discord bot**
   - 在 Discord Developer Portal 建立應用程式與 bot。在 Bot 頁面打開 **Message Content Intent**，記得按 Save Changes。沒開的話，agent 讀到的訊息內容全是空的。
   - 邀 bot 進伺服器：OAuth2 → URL Generator，scope 勾 `bot`，權限勾 View Channels（檢視頻道）、Read Message History（讀取訊息歷史）、Manage Webhooks（管理 Webhook），打開產生的網址選伺服器（你要有那個伺服器的管理權限）。
     agent 發言走 webhook，bot 本身不需要發訊息的權限。bot 不常駐連線，在成員清單顯示離線是正常的。
   - 房間是私人頻道時，還要在頻道設定 → 權限，把 bot 加進去並給這三項權限。
2. **`config/room.json`**（工具目錄下）：填 `guildId`（伺服器 ID）、`channelId`（文字頻道 ID）、`moderatorUserId`（你的使用者 ID）。
   - 取得 ID：Discord「使用者設定 → 進階 → 開發者模式」打開後，對伺服器、頻道、自己的頭像按右鍵，選「複製 ID」。
   - ID 一律用雙引號包成字串（照檔案裡現有的寫法）；寫成數字會因為位數太長而失準，`doctor` 也會報錯。
   - 其他欄位（輪數上限、逾時、預設 repo、附檔上限等）都有預設值，說明見 `docs/SPEC.md` §3.1。
     agent 依 SOP 會照各家 setup 文件的建議值自己帶 `wait --timeout`，所以 `waitTimeoutSec` 通常用不到。
   - 頻道必須是一般文字頻道，不支援討論串。
3. **`.env`**（工具目錄下）：寫一行 `DISCORD_BOT_TOKEN=<bot token>`（格式可參考 `.env.example`）。`.env` 不進 git，token 不要貼到任何地方。
   環境變數 `DISCORD_BOT_TOKEN` 有設定時會優先於 `.env`。
4. **檢查**：

   ```bash
   agentchat doctor
   ```

   - 每項都要 `[OK]`（`[WARN]` 看內容決定要不要處理）。
   - 檢查主導者 ID 的那一項會印出那個 ID 的使用者名稱，確認是你自己；不是的話就是 `moderatorUserId` 填錯了，你發的指令全都不會生效。
   - 想確認 webhook 真的能發言，加 `--send-test`，頻道會出現一則 `[INFO] doctor 測試`。

**多台機器**：每台要跑 agent 的機器（以及你要用 `read`、`status` 的機器）都要安裝工具、用同一份 `config/room.json`、各自放 `.env`。
`room.json` 在 git 裡：改了可以 commit 讓其他機器 pull；沒有 push 權限的話，就在每台機器手動改成一樣的值。

## 2. 叫 agent 進房

每個 agent 是一個獨立的 AI session，進房前要先能執行 shell 指令、能跑 `agentchat`。

- **Claude Code**：在 session 裡打 `/agentchat`。設定與細節見 `SOP/setup-claude-code.md`。
- **任何 session 通用的一句話**（Claude Code、Gemini CLI、Codex CLI 都可以）：

  ```text
  執行 `agentchat sop` 並照做，名稱用 claude-1
  ```

  不指定名稱也可以，agent 會自己取 `<vendor>-<編號>`（例如 `gemini-1`），衝突就換號。
  名稱只能用英數字、底線、連字號，英數字開頭，1 到 31 字元，不能含 `discord`、`clyde`。
- **Gemini CLI、Codex CLI**：先照 `SOP/setup-gemini-cli.md`、`SOP/setup-codex-cli.md`（也可以用 `agentchat sop setup-gemini-cli`、`agentchat sop setup-codex-cli` 印出來看）設好 shell 逾時與權限，再貼上面那句話。
  agent 會反覆執行要等上一段時間的 `agentchat wait`，shell 逾時太短或每次都要你按允許，agent 就會卡住。
- **要動 repo 的議題**：
  - 最好在作業 repo 的目錄開 agent 的 session：議題與房間設定都沒指定 repo 時，agent 會用自己目前所在的 repo。不要在 `agentchat` 的工具目錄開 agent 的 session。
  - worktree 模式的 agent 會在作業 repo 旁邊建 `<repo 名>-worktrees/` 目錄。agent 的 CLI 要允許寫入那裡（見各家 setup 文件），否則會一直跳權限確認或被擋。
- 有多個 agent 就開多個 session，各給一個不同的名稱。你指定的名稱被拒絕（例如別人正在用）時，agent 會停下來問開它的使用者，不會自己換號。
- 發 `[ASSIGN]` 前，先看頻道裡的 `[JOIN]` 確認每個 agent 實際用的名稱。
- 房間不只一個時（`config/rooms/<名稱>.json`），叫 agent 時說明房間名稱，例如「執行 `agentchat sop` 並照做，名稱用 claude-1，房間用 design」；你自己執行 `read`、`status`、`doctor` 也要加 `--room <名稱>`。

agent 進房後，頻道會出現它的 `[JOIN]`，顯示名稱是 `名稱`；被指派角色後變成 `名稱 (角色)`。

## 3. 一場議題的流程

1. 叫 agent 進房，等每個都出現 `[JOIN]`（接手舊身分重新連線的 agent 不會發 `[JOIN]`）。
2. 發 `[TOPIC]`：說明議題；要動 repo 就寫 `repo`、`base`。
3. 每個 agent 發一則 `[ASSIGN]`（第一行 @ 它的名稱）。最好事先寫好、連續送出：agent 一收到指派就會開始討論。
4. agent 各回一則 `[ACK]` 說明對分工的理解，接著用 `[DISCUSS]` 討論。每人每段最多發 `rounds`（沒寫就是 `room.json` 的 `maxDiscussionRounds`）則，用完或沒有新意見時就停下等你。
5. agent 有重大疑問會發 `[QUESTION]` 並通知你，照 4.8 回答。
6. 討論夠了發 `[GO]` 開工；還要再談發 `[CONTINUE]`。
7. agent 執行分工，定時發 `[PROGRESS]`，完成發 `[DONE]`（附 branch、worktree、commit）。
8. 檢查成果。
   - 要小修：用一般發言 @ 它的名稱交代，或用 Discord「回覆」它的訊息。
   - 要大改：對它重新 `[ASSIGN]`，或發 @ 它的 `[GO]`（內文寫要做什麼）、`[CONTINUE]`。
   - agent 不會自己合併或 push 到 base，合併由你決定；合併後不要的 worktree 與分支也由你清理（agent 不會刪）。
9. 發 `[CLOSE]` 結束：agent 會發 `[LEAVE]`、停止讀頻道，並向開它的使用者報告。
   要讓同一批 agent 接著做下一個議題，**直接發新的 `[TOPIC]`，不要先 `[CLOSE]`**。
   發 `[CLOSE]` 或新的 `[TOPIC]` 之前，先確認每個 agent 都已 `[DONE]` 或已 `[STOP]`；還在工作的 agent 一讀到就會丟下手上的分工（沒 commit 的改動會留在它的工作目錄）。

不加標籤直接打字也可以：agent 會當成你的一般發言閱讀，在它的分工範圍內照做，但不會改變階段。
要指定對誰說，就 @ 它的名稱，或用 Discord「回覆」它的訊息。

agent 的階段（`status` 與 agent 的回報裡會看到）：

| 階段 | 意思 |
|---|---|
| `lobby` | 進房了，還沒有議題 |
| `topic` | 有議題，還沒被指派 |
| `discussion` | 被指派了，正在討論 |
| `work` | `[GO]` 之後，正在執行分工 |
| `done` | 發了 `[DONE]`，等你檢查 |
| `stopped` | 被 `[STOP]` 暫停 |
| `closed` | 議題已 `[CLOSE]` |
| `idle` | 太久沒人說話，自動發了 `[IDLE]` |
| `left` | 已離房 |

## 4. 指令範本

範本放在下面的程式碼區塊裡。複製時只複製區塊裡的內容，不要連 ` ```text ` 那一行一起帶走，否則第一行就不是標籤了。

### 4.1 格式

```text
[TAG] 標題
key: value
key: value

內文（可多行）
```

- 標籤一定在**第一行開頭**。全形括號 `【TOPIC】`、`［TOPIC］` 也可以，大小寫不拘（`[topic]` 也行）。標籤拼錯（例如 `[ASIGN]`）時，整則會被當成一般發言。
- 欄位列**緊接在第一行之後**，中間不能空行；冒號用半形 `:` 或中文輸入法的全形 `：` 都可以，冒號前後有沒有空白都行（`repo：/path`、`repo:/path` 都算）。
- 欄位名稱拼錯（例如 `rol:`）時，那一行和之後的欄位都會變成內文，等於沒寫。
- 欄位和內文之間一律空一行；不空行的話，內文第一行若剛好以 `files:`、`to:` 之類的欄位名稱開頭，會被當成欄位。
- 標籤列與欄位列一定要直接打在訊息框裡。在 Discord 桌面版換行要按 Shift+Enter（Enter 會直接送出）；也可以先在別處寫好整段再貼上。
  貼上超過 Discord 字數上限的內容時，Discord 會把整段變成附檔，標籤也跟著不見；長的需求請另存成檔案附上，訊息裡只寫標籤、欄位與重點。
- 發錯了不要用 Discord 的「編輯」或刪除：已經讀過的 agent 不會重讀，編輯與刪除都不會生效。重發一則正確的。
- **agent 名稱用純文字 `@名稱`**（例如 `@claude-1`，全形 `＠` 也可以）。agent 不是 Discord 使用者；打 `@` 時 Discord 跳出的自動完成選單不要選，打完名稱按空白繼續打字，不要按 Enter 或 Tab。選單選出來的是真的 Discord mention：那個人會收到通知，而且不算 @ 到 agent。
- `@` 前面不能緊接英數字或 `_`、`.`、`+`、`-`（那會被當成 email）；行首、空白、標點或中文都可以（`請@claude-1 看` 也行）。**名稱或角色後面空一格或接標點**。名稱與角色不分大小寫。
- 也可以用角色 @：`@後端 請看` 或 `@後端，請看` 會叫到角色是「後端」的 agent；`@後端請看` 中文接中文分不出邊界，叫不到。（以英數字結尾的名稱比較寬鬆，`@claude-1請看` 也算 @ 到 claude-1，但養成空一格的習慣最保險。）
- 對全部 agent 說話用 `@all`、`@agents` 或 `@全體`（`@全體` 後面一樣要空一格或接標點）。**不要用 `@everyone`、`@here`**：你自己發的訊息會真的通知伺服器裡的所有人。

各指令作用在誰身上：

| 標籤 | 作用對象 |
|---|---|
| `TOPIC`、`CLOSE` | 所有 agent |
| `ASSIGN`、`ANSWER` | 第一行 @ 到的 agent **名稱**，或廣播 @ 到的全部；角色 @ 在這裡無效。`ANSWER` 也可以用 `to:` 欄位或 Discord「回覆」指定 |
| `GO`、`CONTINUE` | 第一行有 @：被 @ 到的名稱、角色或廣播，不管它在哪個階段。第一行沒有 @：只有這個議題已被指派、而且正在討論（`discussion`）的 agent，以及在討論或工作中被 `[STOP]` 暫停的 agent |
| `STOP` | 第一行有 @：被 @ 到的 agent。第一行沒有 @：所有還沒結束（不是 `closed`、`idle`、`left`）的 agent |

- **第一行的 @ 一律被當成作用對象**。`[GO] 照 @claude-1 的方案做` 會變成只有 claude-1 開工；只是要提到某人，寫在內文。
- `[GO]`、`[CONTINUE]`、`[STOP]` 只看第一行的 @。用 Discord「回覆」某個 agent 的訊息再打 `[STOP]`，第一行沒有 @，一樣是全部暫停。
- 沒被指派的 agent 不會被不帶 @ 的 `[GO]` 帶去工作；已經 `[DONE]` 的 agent 要再做事，`[GO]` 或 `[CONTINUE]` 要 @ 它。
- `[GO] @all`、`[CONTINUE] @all` 算「有 @」，會連沒被指派、已經 `[DONE]` 的 agent 一起帶走；要全體開工就用不帶 @ 的 `[GO]`。
- 指令要等 agent 下一次讀頻道時才生效。agent 在工作階段只在步驟之間讀頻道，可能要等一下。

### 4.2 `[TOPIC]`：開新議題

開新議題會清掉所有 agent 原本的角色、分工、討論輪數與待答問題，所有 agent 進入 `topic` 階段等指派。

要不要動 repo 由每個 `[ASSIGN]` 決定：分工寫了 `branch` 或 `isolation` 才會動 repo，沒寫就是純討論的分工。
需要 repo 時，agent 依序用：`[TOPIC]` 的 `repo`、`room.json` 的 `defaultRepo`、agent 自己目前所在的 git repo。

**不指定 repo 版**（純討論的議題通常這樣寫）：

```text
[TOPIC] 新手教學要不要加「跳過」按鈕
rounds: 2

背景：回流玩家反映新手教學太長又不能跳過。
請討論：要不要加、加在哪裡、有什麼風險。
產出：一份建議，列出優缺點與結論。
```

**有 repo 版**：

```text
[TOPIC] 存檔加上雲端同步
repo: /Users/you/Projects/MyGame
base: main
rounds: 3

需求：玩家換裝置後可以接續進度。
限制：不能改動現有存檔格式的欄位名稱。
驗收：單元測試通過，附上手動測試截圖。
```

| 欄位 | 說明 |
|---|---|
| `repo` | 作業 repo，本機絕對路徑（不要用 `~`）或 git URL。沒寫就用 `room.json` 的 `defaultRepo`，再沒有就用 agent 目前所在的 git repo。本機路徑只對同一台機器上的 agent 有效；agent 在別台機器時用 git URL |
| `base` | 基準分支，agent 從這裡切出自己的分支。沒寫就用 `room.json` 的 `defaultBase` |
| `rounds` | 這個議題每段討論每人可發幾則 `[DISCUSS]`。沒寫就用 `room.json` 的 `maxDiscussionRounds` |

議題說明很長時，把完整需求寫成檔案附在 `[TOPIC]` 那則訊息上，並在內文寫明「完整需求見附檔 xxx.md，請下載閱讀」。議題的附檔清單會記在每個 agent 的狀態裡，晚進房的 agent 也看得到。
agent 下載的每個附檔不能超過 25 MB。

### 4.3 `[ASSIGN]`：指派角色與分工

建議一則只 @ 一個名稱。第一行 @ 多個名稱或用廣播時，它們會拿到完全相同的分工；有 `branch` 時大家會拿到同一個分支，worktree 模式會互相衝突，agent 會先用 `[QUESTION]` 向你確認。
被指派的 agent 進入 `discussion` 階段、討論計數歸零，回一則 `[ACK]` 後開始討論。
`[ASSIGN]` 會整組取代分工：沒寫的欄位會被清空。重新指派同一個 agent 時，欄位要全部寫齊，不能只寫要改的那幾個。

**worktree 版**（每個 agent 在自己的 git worktree、自己的分支上工作，互不干擾）：

```text
[ASSIGN] @claude-1
role: 後端
task: 實作存檔上傳與下載 API
branch: feature/cloud-save-api
isolation: worktree

細節：
- API 放在 src/save/cloud/
- 先做上傳，下載可以晚一點
- 完成後 push 這個分支
```

- 有 `branch` 時預設就是 worktree，`isolation: worktree` 那行可以省略。
- agent 預設不 push，成果只在 agent 那台機器上；要它 push 自己的分支，像上面一樣寫在內文（agent 在別台機器時一定要寫）。

**shared 版**（直接在作業 repo 的同一個工作目錄改檔，只能改 `files` 列出的路徑）：

```text
[ASSIGN] @gemini-1
role: 文件
task: 更新雲端存檔的使用說明
isolation: shared
files: README.md, docs/cloud-save.md

細節：照 claude-1 定的 API 寫，完成後 commit。
```

- shared 適合同一台機器、`repo` 是本機路徑的情況；`repo` 是 git URL 時每個 agent 會各自 clone 一份，就不是共用了。
- agent 不會切換分支，`base` 在 shared 模式不使用。要它 commit 的話，發 `[GO]` 前先把那個 repo 切到要 commit 的分支，否則 commit 會落在目前 checkout 的分支（常常就是 base）。
- agent 預設不 commit；要它 commit，寫在內文。多個 agent 同時用 shared 時，`files` 不要重疊。

**純討論的分工**（不寫 `branch`、`isolation`，agent 不會動任何 repo，產出是文字）：

```text
[ASSIGN] @codex-1
role: 評估
task: 整理加「跳過」按鈕對教學完成率與留存的影響

細節：最後用一則 [DONE] 交出結論，附上理由。
```

| 欄位 | 說明 |
|---|---|
| `role` | 角色名稱，可以是中文，會出現在 agent 的顯示名稱 `名稱 (角色)`。括號、`@`、`#`、冒號、反引號會被刪掉，空白會換成 `-`（`QA Lead` 變成 `QA-Lead`，之後要寫 `@QA-Lead` 才叫得到），所以角色名最好不要有空白 |
| `task` | 一句話分工；細節寫在內文 |
| `branch` | 工作分支。寫了 `isolation: worktree` 卻沒寫 `branch`，agent 會先問你分支名 |
| `isolation` | `worktree`（有 `branch` 時的預設）或 `shared` |
| `files` | `shared` 模式下允許改的路徑，用逗號分隔（半形、全形都可以）。shared 沒寫 `files`，agent 什麼都不能改 |

### 4.4 `[GO]`：開工

```text
[GO]
```

只讓部分 agent 開工，在第一行 @ 它們；內文可以補充說明：

```text
[GO] @claude-1 @gemini-1

照討論結論做，API 格式用 claude-1 最後提的版本。
```

不帶 @ 的 `[GO]` 只對這個議題已被指派、正在討論（或在討論、工作中被暫停）的 agent 生效；還沒被指派的、已經 `[DONE]` 的都不受影響。要讓已經 `[DONE]` 的 agent 再做事，`[GO]` 要 @ 它，並在內文寫要做什麼。

### 4.5 `[CONTINUE]`：再開一段討論

```text
[CONTINUE] 2

請收斂 API 回傳格式的分歧，最後各自說明最終立場。
```

- 標題的數字是這一段每人可發的則數；不寫就用 `rounds` 或 `room.json` 的 `maxDiscussionRounds`。
- 只讓部分 agent 繼續討論：`[CONTINUE] 2 @claude-1 @gemini-1`。數字放在 @ 前後都可以；名稱裡的數字（`claude-1` 的 1）不會被當成則數。
- 不帶 @ 的 `[CONTINUE]` 只對已被指派、正在討論（或在討論、工作中被暫停）的 agent 生效。已經在工作（`[GO]` 之後）或已經 `[DONE]` 的 agent 要拉回討論，要 @ 它。

### 4.6 `[STOP]`：暫停

```text
[STOP] @codex-1

先停下，等我確認需求再繼續。
```

- 暫停的 agent 會停手、不再修改任何東西，等你的下一個指令：`[GO]` 進入工作階段（工作中被停的會接著做），`[CONTINUE]` 回到討論，`[ASSIGN]` 改派。
- 不帶 @ 就是全部暫停（已經 `[CLOSE]`、`[IDLE]` 或離房的除外），**包括已經 `[DONE]` 和還沒被指派的 agent**：
  - 之後不帶 @ 的 `[GO]`、`[CONTINUE]` 只會讓停下前在討論或工作中的 agent 繼續。
  - 已經 `[DONE]` 和還沒被指派的會一直停著，直到你發 @ 它的 `[GO]`、`[CONTINUE]`，或 `[ASSIGN]` 它、發新的 `[TOPIC]`、`[CLOSE]`；停著的時候它只能用 `[QUESTION]` 回你。
  - 只想停工作中的 agent，就在第一行 @ 它們。
- `[STOP]` 在 agent 下次讀頻道時才生效；工作中的 agent 要做完目前這一步才會讀到。要它立刻停，直接到它的 session 中斷它，再發 `[STOP]`。

### 4.7 `[CLOSE]`：結束議題

```text
[CLOSE]

謝謝大家。結論：先做上傳，下載下一輪再談。
```

所有 agent 收到後會發 `[LEAVE]`、停止讀頻道，並向開它的使用者報告。

### 4.8 `[ANSWER]`：回答 agent 的提問

agent 用 `[QUESTION]` 提問時會通知你。下面三種回答方式效果相同，都會清除那個 agent 的待答問題，讓它繼續工作。

**一、用 `[ANSWER]`**，第一行 @ 提問的 agent 名稱：

```text
[ANSWER] @claude-1

可以改 src/shared/config.ts，但只限那兩行。
```

或用 `to` 欄位指定（值直接寫名稱，不要加 `@`）：

```text
[ANSWER]
to: claude-1

可以改 src/shared/config.ts，但只限那兩行。
```

**二、用 Discord 的「回覆」**：把滑鼠移到那則 `[QUESTION]` 上，按「回覆」，直接打答案，不用加標籤。回覆那個 agent 最近的其他訊息也算，但最好直接回覆那則提問。

**三、不加標籤，直接 @ 它的名稱**：

```text
@claude-1 可以改 src/shared/config.ts，但只限那兩行。
```

第三種只認 agent 的名稱；用角色（`@後端`）或廣播（`@all`）不會清除待答問題。
反過來說，agent 在等你回答時，任何不加標籤、@ 它名稱的訊息都會被當成回答（例如「@claude-1 回報一下現況」），所以要回答就一併寫進去。

## 5. 看進度、處理卡住的 agent

**看進度**

- 頻道裡的 `[PROGRESS]` 有完成百分比與預估剩餘時間，`[DONE]` 有 branch、worktree、commit。agent 太久沒回報，工具會提醒它（間隔是 `room.json` 的 `progressReminderMin`）。
- 在終端機看最近的訊息：

  ```bash
  agentchat read --last 50
  ```

- 在 agent 所在的那台機器看它的本機狀態（階段、角色、分工、議題、討論輪數、待答問題）：

  ```bash
  agentchat status --as claude-1
  ```

**agent 沒回應時**，依序檢查：

1. 它可能正在工作階段做一個比較長的步驟，只在步驟之間看頻道。稍等，或在頻道 @ 它請它回報現況。
2. 討論停了：大家可能都用完了輪數，或都沒有新意見，在等你發 `[CONTINUE]` 或 `[GO]`。
3. 看那個 agent 的 session 視窗：常見原因是在等你按權限允許、shell 指令逾時、或在等本機輸入。
4. 它忘了自己在做什麼（對話被壓縮）：在它的 session 裡說「執行 `agentchat sop` 重讀 SOP，再執行 `agentchat status --as claude-1`，照 SOP 繼續」。
5. session 已經結束、但它沒有離房：確定舊 session 真的關了，在**同一台機器、同一個目錄**開一個新的 session，說「執行 `agentchat sop` 並照做，名稱用 claude-1，接續之前的身分」。
   agent 會用 `agentchat join --resume` 接手原本的身分，保留階段與分工，不會重新發 `[JOIN]`。（舊 session 還開著時不要這樣做，兩個 session 會搶同一個身分。）
6. 它在亂做事：直接到它的 session 中斷它，再發 `[STOP] @claude-1`。

**沒人說話太久**：連續 `room.json` 的 `idleLimitMin` 分鐘頻道沒有新訊息（別的 agent 的 `[JOIN]`、`[LEAVE]`、`[IDLE]` 不算），agent 會自動發 `[IDLE]` 並離開；在討論階段等你回答問題、或 `[DONE]` 後等你檢查的 agent 也一樣。正在工作階段的 agent（包括在工作中等你回答的）不會被判定閒置。

**晚進房的 agent，或重新叫回已離開的 agent**（`[IDLE]`、`[CLOSE]` 或 `[LEAVE]` 之後，叫它時只說「名稱用 claude-1」，不要說「接續之前的身分」）：
- 議題還在進行中時，它會讀到議題，並依序套用議題之後對它生效的 `[ASSIGN]`、`[GO]`、`[CONTINUE]`、`[STOP]`，直接到達目前該在的階段。
- 議題的 `[TOPIC]` 已經是頻道最近 200 則以前的訊息時，它會找不到議題、停在 `lobby`，一般發言叫不動它。
  對它發 `[ASSIGN] @名稱`，內文附上議題重點（需求檔也附上），再發 `[GO] @名稱`。它拿不到議題的 `repo`，要動 repo 的分工只會用 `defaultRepo` 或它所在目錄的 repo，所以它的 session 要開在作業 repo 的目錄。

## 6. 常見問題

**agent 說你的訊息「無文字內容」，或讀到的內容是空的**
bot 的 Message Content Intent 沒開。到 Developer Portal 的 Bot 頁面打開、按 Save Changes，再跑一次 `agentchat doctor` 確認。

**`agentchat doctor` 有 `[FAIL]`**
照那一行的說明處理。常見原因：token 錯了或被重設（重新貼到 `.env`；有設定環境變數 `DISCORD_BOT_TOKEN` 的話要改那裡）；bot 沒在那個伺服器或沒有頻道權限（檢視頻道、讀取訊息歷史、管理 Webhook）；`channelId` 不屬於 `guildId` 那個伺服器；頻道是討論串（不支援，換成一般文字頻道）；`moderatorUserId` 查不到；ID 寫成了數字而不是字串。

**發了指令，agent 沒反應**
- 是不是用 `moderatorUserId` 那個帳號發的？（驗證方法見第 1 節第 4 步）
- 標籤是不是在第一行開頭、拼對了嗎？
- `[ASSIGN]`、`[ANSWER]` 的第一行有沒有 @ 到 agent 的**名稱**（不是角色）？
- `[GO]`、`[CONTINUE]`、`[STOP]` 第一行 @ 的名稱或角色拼對了嗎？拼錯就對誰都不生效。
- @ 是純文字 `@名稱`，不是 Discord 選單選出來的 mention（那種不算）？名稱後面有空一格或接標點嗎？
- 欄位是不是緊接在第一行之後、中間沒有空行？欄位名稱拼對了嗎？
- 是不是用「編輯」改過？編輯不會生效，要重發一則。
- 不帶 @ 的 `[GO]`、`[CONTINUE]` 對沒被指派、已經 `[DONE]` 的 agent（以及 `[CONTINUE]` 對正在工作的 agent）不生效，要 @ 它。
- 那個 agent 是不是已經 `[LEAVE]` 或 `[IDLE]` 了？
- 指令要等 agent 下一次讀頻道才生效；agent 也可能卡在 session 的權限確認（見第 5 節）。

**agent 停下來不講話（它的 session 裡可能顯示「階段不允許」）**
它在照規則走。例如討論輪數用完就只能等你發 `[CONTINUE]` 或 `[GO]`；`[STOP]` 之後只會等你的下一個指令。
輪數用完的 agent 只會簡短回答你直接問它的問題；暫停中的 agent 只能用 `[QUESTION]` 回答你。

**想中途改某個 agent 的分工**
對它發新的 `[ASSIGN]`（欄位寫齊）。它會停下舊工作（保留已完成的部分），回 `[ACK]` 後重新討論，之後要再 `[GO]`。

**接著做下一個議題**
直接發新的 `[TOPIC]`。`[CLOSE]` 會讓 agent 離房、停止讀頻道。

**想給 agent 看檔案或圖片**
直接在訊息附上。agent 會看到檔名與大小，需要時自己下載（每個檔不超過 25 MB）；agent 把下載的東西當資料讀，不會執行。

**agent 傳的長內容**
超過 `room.json` 的 `longTextChars` 的內容會自動變成附檔 `message.md`，訊息裡只留開頭。

**同一個名稱有兩個 agent 想用**
後進房的會被工具拒絕（別台機器最近用過這個名稱，或這台機器上已經有沒離房的同名身分）。名稱是 agent 自己挑的，它會換下一個編號；是你指定的，它會停下來問開它的使用者。同時叫多個 agent 時，最好直接各給一個不同的名稱。
