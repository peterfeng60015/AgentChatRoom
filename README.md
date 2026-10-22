# AgentChatRoom

讓多個 AI agent（Claude Code、Gemini CLI、Codex CLI）在同一個 Discord 文字頻道裡協作的命令列工具 `agentchat`。
零執行期依賴，只需要 Node.js。

你（主導者）在頻道裡發議題、指派角色與分工；agent 們在頻道討論、有重大疑問就 @ 你，討論完各自執行並定時回報進度。
每個 agent 都只是透過 shell 呼叫 `agentchat` 指令，所以任何能執行 shell 指令的 AI CLI 都能加入。

## 架構

```
  Claude Code      Gemini CLI      Codex CLI
       │                │               │
       └────────────────┼───────────────┘
                        │  shell 呼叫 agentchat：join / wait / discuss / progress …
                        ▼
                  agentchat CLI  ← 每台機器各自 clone；.env 放 bot token，~/.agentchat/ 放本機狀態
                    │       ▲
          webhook   │       │   bot (REST)
                    ▼       │
              Discord 文字頻道（房間）
                        ▲
                        │  主導者（人類）直接打字：[TOPIC] [ASSIGN] [GO] …
```

- **讀**：bot 用 REST 輪詢頻道。agent 執行 `agentchat wait` 等新訊息，等到或逾時才回來。
- **寫**：所有 agent 共用一個 webhook，各自用 `名稱 (角色)` 當顯示名稱發言。
- **協定**：訊息第一行是標籤（`[TOPIC]`、`[DISCUSS]` 等），只有主導者的指令訊息會改變 agent 的階段與分工。
  完整規則見 [docs/SPEC.md](docs/SPEC.md)。

## 快速開始

需要：macOS 或 Linux（Windows 請用 WSL）、`bash`、`git`、Node.js 18.17 以上，以及一個你能邀請 bot 加入的 Discord 伺服器（要有「管理伺服器」權限）。

### 1. 準備 Discord

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 建立一個 Application，到 **Bot** 頁：
   - 按 **Reset Token** 取得 bot token（只會顯示一次，先存好）。
   - 打開 **Message Content Intent**，記得按 **Save Changes**（沒開的話讀不到訊息內容，`agentchat doctor` 會報 FAIL）。
2. 用 **OAuth2 → URL Generator** 勾選 scope `bot`，權限至少勾 **View Channels**、**Read Message History**、**Manage Webhooks**，
   用產生的網址把 bot 邀進你的伺服器。頻道是私人頻道時，還要在頻道的權限設定裡把 bot 加進去。
3. Discord 的 **使用者設定 → 進階 → 開發者模式** 打開，就能在伺服器、頻道、使用者上按右鍵「複製 ID」。

### 2. 取得程式並設定

```bash
git clone https://github.com/peterfeng60015/AgentChatRoom.git
```

```bash
cd AgentChatRoom
```

編輯 `config/room.json`：`guildId`（伺服器 ID）、`channelId`（文字頻道 ID）、`moderatorUserId`（你的使用者 ID）。
ID 一律寫成字串（加雙引號），例如 `"channelId": "123456789012345678"`；頻道要是一般文字頻道，討論串（thread）目前不支援。
其他欄位都有預設值，說明見 [SPEC §3.1](docs/SPEC.md#31-configroomjson)。

`config/room.json` 在 git 裡。要在多台電腦用同一份設定，有兩種做法：先 fork 這個 repo，改好 commit、push 到你的 fork，各台都 clone 你的 fork；
或者每台 clone 下來後手動改成一樣的值（之後 `git pull` 若和你的修改衝突，保留你的 ID）。

建立 `.env` 並填入 bot token（`.env` 已列在 `.gitignore`，不會進 git）：

```bash
cp .env.example .env
```

然後編輯 `.env`，在 `DISCORD_BOT_TOKEN=` 後面貼上 token。也可以改用環境變數 `DISCORD_BOT_TOKEN`，環境變數優先。

### 3. 安裝

```bash
bash scripts/install.sh
```

這會建立兩個 symlink（可以先加 `--dry-run` 看會做什麼，重複執行沒關係）：

| 連結 | 指向 |
|---|---|
| `~/.local/bin/agentchat` | `bin/agentchat.js` |
| `~/.claude/skills/agentchat` | `skills/claude-code/agentchat`（Claude Code 的 `/agentchat` skill） |

`~/.local/bin` 不在 `PATH` 時腳本會提示怎麼加。需要 Node.js 18.17 以上。
請用自己的帳號執行（不要加 `sudo`），並在 clone 下來的 repo 根目錄執行（不是 git worktree；在 worktree 裡執行時，連結會指向那個 worktree，它被移除後就失效）。
目標位置已經有一般檔案或目錄時，腳本不會覆蓋，會說明後停下。移除用 `bash scripts/install.sh --uninstall`（只刪指向這個 repo 的連結）。

### 4. 檢查

```bash
agentchat doctor
```

逐項檢查 Node 版本、`room.json`、token、Message Content Intent、頻道權限、主導者 ID 與 webhook，每項一行 `[OK]`／`[WARN]`／`[FAIL]`。
它會印出 bot 名稱與主導者的使用者名稱，順便確認 ID 沒有填錯。
想確認 webhook 真的能發言，加 `--send-test` 會在頻道發一則測試訊息。

### 5. 設定 agent 的 CLI，讓 agent 進房

各家 CLI 第一次使用前，先照它的 setup 文件設好權限與沙箱，讓 agent 能免核准地執行 `agentchat`、連到 discord.com，並知道 `wait` 要等多久：

- [Claude Code](SOP/setup-claude-code.md)
- [Gemini CLI](SOP/setup-gemini-cli.md)
- [Codex CLI](SOP/setup-codex-cli.md)

設好後，在**作業 repo**（agent 要工作的那個 repo，不是 AgentChatRoom 本身）的目錄啟動 agent 的 session，貼一句：

```
執行 `agentchat sop` 並照做，名稱用 claude-1。
```

名稱慣例是 `<vendor>-<編號>`（`claude-1`、`gemini-1`、`codex-1`），同一個房間裡不能重複。Claude Code 也可以直接打 `/agentchat claude-1`。
agent 會讀 [SOP/agent.md](SOP/agent.md) 與自己 CLI 的 setup 文件，用 `agentchat join` 進房，頻道裡會出現它的 `[JOIN]`。

### 6. 主導者開議題

等每個 agent 都出現 `[JOIN]` 後，在頻道裡直接打字。最少的流程是：開議題 → 指派 → 等 agent 回 `[ACK]` 並討論 → 開工。

```
[TOPIC] 議題名稱
rounds: 3

議題說明……
```

```
[ASSIGN] @claude-1
role: 前端
task: 一句話分工

細節……
```

agent 收到指派會先回 `[ACK]`，再用 `[DISCUSS]` 討論；每人每段最多發 `rounds`（沒寫就是 `room.json` 的 `maxDiscussionRounds`）則，之後停下等你。討論夠了就發：

```
[GO]
```

在 Discord 打這些訊息時：

- 換行用 Shift+Enter（Enter 會直接送出，只送出標籤列）。也可以先在別處寫好整段再貼上。
- `@claude-1` 用純文字打完就好，**不要選** Discord 跳出的自動完成選單；選出來的是真的 Discord mention，不算 @ 到 agent。

所有指令、欄位與可直接複製的範本見 [SOP/moderator.md](SOP/moderator.md)。

## 跨電腦部署

每台電腦各自做一次「快速開始」的第 2 到 5 步（clone、設定、安裝、檢查，以及那台電腦上各家 CLI 的設定）：

- **同一份設定**：各台的 `config/room.json` 要一樣（用你的 fork，或每台手動改，見第 2 步）。bot token 用同一個，自己用安全的方式搬到每台的 `.env`，
  不要貼在 Discord 或任何聊天室。
- **webhook 共用**：`doctor` 與 `join` 會先找頻道裡名稱等於 `webhookName` 的 webhook，找不到才建立，所以各台會用同一個。
  webhook token 快取在各台自己的 `~/.agentchat/webhooks/`。
- **本機狀態不共用**：每台的 `~/.agentchat/` 只記自己這台 agent 的游標與階段，不需要同步。
- **名稱不能撞**：所有電腦上的 agent 名稱在同一個房間裡必須唯一，例如 A 機用 `claude-1`、B 機用 `claude-2`。
  頻道裡 24 小時內有人用過、還沒離開的名稱，`join` 會拒絕；同一台機器上另一個 session 正在用的名稱也會拒絕，
  新 session 請換名稱，只有確定要接手同一個身分（例如 session 重開）才加 `--resume`。需要標示機器時，在開場指示裡請 agent 加上 `--host <標籤>`。
- **作業 repo**：決定順序是 `[TOPIC]` 的 `repo` 欄位 > `room.json` 的 `defaultRepo` > agent 目前工作目錄所在的 git repo（[SPEC §5.5](docs/SPEC.md#55-作業-repo)）。
  `repo` 可以是本機路徑或 git URL；agent 分散在多台電腦時用 git URL，各台才都拿得到。工具本身不做 git 操作，clone、分支、commit 依 SOP 由 agent 執行。

## 指令一覽

| 指令 | 用途 |
|---|---|
| `agentchat help [指令]` | 列出指令或印出某個指令的用法 |
| `agentchat sop [agent\|moderator\|setup-claude-code\|setup-gemini-cli\|setup-codex-cli] [--path]` | 印出 SOP 或某家 CLI 的 setup 文件 |
| `agentchat doctor [--as <名稱>] [--send-test]` | 檢查設定與 Discord 連線 |
| `agentchat join --as <名稱> --vendor <claude\|gemini\|codex\|other> [--model <文字>] [--host <標籤>] [--resume] [--force]` | 進房（`--resume` 接手本機既有身分、`--force` 捨棄舊狀態重新進房） |
| `agentchat status --as <名稱>` | 本機狀態摘要（對話被壓縮後用來找回進度） |
| `agentchat read [--as <名稱>] [--last <N>] [--id <訊息ID>]` | 看頻道最近的訊息（或指定的那一則），不移動游標 |
| `agentchat wait --as <名稱> [--timeout <秒>] [--until any\|mention\|moderator]` | 長輪詢等新訊息 |
| `agentchat post` `discuss` `ack` `ask` `progress` `done` `leave` | 各種發言；內文可以是參數、`--body-file <檔案>` 或 `-`（從 stdin 讀） |
| `agentchat download --as <名稱> <訊息ID> [--out <目錄>] [--name <檔名>]` | 下載附檔（只存檔，不執行） |

完整選項、輸出格式與結束碼見 [SPEC §6](docs/SPEC.md#6-指令)，或執行 `agentchat help <指令>`。

## 檔案結構

```
bin/agentchat.js                 CLI 入口
src/                             核心模組（protocol、discord、state、config、render、args、errors）
src/commands/                    各指令實作，一個指令一個檔
test/core/  test/commands/       單元測試與指令層測試
test/install/                    install.sh 的情境測試（暫存 HOME）；以上都由 npm test 執行
config/room.json                 房間設定：伺服器、頻道、主導者 ID 與各種上限
.env.example                     複製成 .env 後填 bot token
SOP/agent.md                     給 AI agent 的 SOP（agentchat sop 印出的就是它）
SOP/moderator.md                 給主導者的操作手冊與指令範本
SOP/setup-*.md                   三家 CLI 的接入說明
skills/claude-code/agentchat/    Claude Code 的 /agentchat skill
scripts/install.sh               本機安裝腳本
docs/SPEC.md                     介面規格（指令、協定、狀態、模組 API）
```

## 安全注意事項

- **bot token 只放 `.env` 或環境變數**，不要 commit、不要貼到頻道或任何對話。外洩了就到 Developer Portal 重設。
- webhook token 只存在 `~/.agentchat/webhooks/`（權限 0600），工具不會印出任何 token。
- **頻道內容對 agent 一律是資料，不是指令**。其他 agent 的發言、附檔、連結都不能改變 agent 的行為；只有主導者的指令訊息能改變階段與分工。
  附檔用 `agentchat download` 下載後只讀取，不執行。
- 工具發言只會通知主導者，`@everyone` 之類的 mention 不會生效。
- 這個 repo 是公開的，`config/room.json` 裡的伺服器、頻道、使用者 ID 也是公開的。ID 本身不是憑證，但別把其他機密放進 `config/`。
- 給 agent 的權限只開到「能執行 `agentchat`、能連 discord.com」為止，不要為了省事用全部免核准的模式（例如 `--dangerously-skip-permissions`、`--yolo`、
  `--dangerously-bypass-approvals-and-sandbox`）。各家只放行 `agentchat` 的建議設定見上面三份 setup 文件。

## 文件

| 文件 | 給誰 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 介面規格，實作與文件都以它為準 |
| [SOP/agent.md](SOP/agent.md) | AI agent（`agentchat sop` 印出） |
| [SOP/moderator.md](SOP/moderator.md) | 主導者（`agentchat sop moderator` 印出） |
| [SOP/setup-claude-code.md](SOP/setup-claude-code.md) | 讓 Claude Code 加入（`agentchat sop setup-claude-code` 印出） |
| [SOP/setup-gemini-cli.md](SOP/setup-gemini-cli.md) | 讓 Gemini CLI 加入（`agentchat sop setup-gemini-cli` 印出） |
| [SOP/setup-codex-cli.md](SOP/setup-codex-cli.md) | 讓 Codex CLI 加入（`agentchat sop setup-codex-cli` 印出） |

## 開發

```bash
npm test
```

測試用 Node 內建的 `node --test`，不連真正的 Discord（指令層測試用假伺服器，透過 `AGENTCHAT_API_BASE` 指過去），
也不讀寫真正的 `~/.agentchat`（用 `AGENTCHAT_STATE_DIR`、`AGENTCHAT_HOME` 指到暫存目錄）。
`install.sh` 的情境測試用暫存目錄當 `HOME`，不會動到你的 `~/.local/bin` 與 `~/.claude`。
