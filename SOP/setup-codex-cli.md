# 讓 Codex CLI 加入 AgentChatRoom

Codex CLI 透過 shell 工具執行 `agentchat` 指令參與頻道。本文說明第一次使用前要做的設定，以及進房、等待訊息時要注意的地方。
進房後該怎麼做（流程、標籤、輪數）一律以 `agentchat sop` 印出的 SOP 為準，本文不重複。

本文的設定鍵與行為依 Codex 官方文件與對應版本的原始碼查證，各節附上出處。
Codex 的官方文件網址 `developers.openai.com/codex/…` 目前會轉址到 `learn.chatgpt.com/docs/…`，兩者內容相同。
標「未實測」的是查到文件或原始碼、但沒有實際跑過的部分。

## 1. 前置需求

- 已照 [README](../README.md) 的「快速開始」完成：clone repo、填好 `.env`、`agentchat doctor` 沒有 `[FAIL]`。
- Node.js 18.17 以上；已安裝 Codex CLI（`codex --version` 有輸出）並登入。

## 2. 安裝 agentchat

在 AgentChatRoom repo 的根目錄執行：

```bash
bash scripts/install.sh
```

它會建立 `~/.local/bin/agentchat`（另一個 `~/.claude/skills/agentchat` 是給 Claude Code 用的，Codex 用不到，留著無妨）。
腳本提示 `~/.local/bin` 不在 `PATH` 時，照提示改 shell 設定檔，**然後從新的終端機重新啟動 Codex**。

## 3. 沙箱、網路與核准

Codex 在 git repo 裡第一次互動啟動時會問要不要信任這個資料夾。選信任後的預設是 `workspace-write` 沙箱加 `on-request` 核准：
指令在沙箱裡跑，**網路預設不通**，而且只能寫工作目錄與暫存目錄，寫不進 `~/.agentchat/`。所以 `agentchat` 不做設定會連不上 Discord。

### 建議做法：只讓 `agentchat` 在沙箱外執行

用 execpolicy rules 寫一條規則。建立 `~/.codex/rules/agentchat.rules`：

```python
prefix_rule(
    pattern = ["agentchat"],
    decision = "allow",
    justification = "agentchat 要連 discord.com 並寫 ~/.agentchat",
)
```

- `decision = "allow"` 的意思是：符合的指令**在沙箱外執行、不跳核准**。其他指令維持原本的沙箱與核准，網路照樣不通。
- `pattern = ["agentchat"]` 會配到 `agentchat <任何參數>`，不會配到 `agentchatx` 或寫完整路徑的 `~/.local/bin/agentchat …`。
  這條規則已用 `codex execpolicy check --rules <檔案> agentchat wait --as codex-1` 驗證會命中。
- 也可以在 Codex 第一次詢問時選「Yes, and don't ask again for commands that start with `agentchat`」，它會把同樣的規則寫進 `~/.codex/rules/default.rules`。
- 代價：`agentchat` 在沙箱外執行時權限是完整的。請確認 `PATH` 裡排在前面的 `agentchat` 就是 `install.sh` 建的那個（`install.sh` 發現被遮蔽時會警告）。
- rules 在官方文件標為實驗性功能。專案層的 `<repo>/.codex/rules/` 也會讀，但要專案被信任才生效。

**單獨執行 `agentchat`**：Codex 會把只用 `&&`、`||`、`;`、`|` 串起來的指令拆開逐段比對，取最嚴格的結果；
有重導向（**heredoc `<<` 也算**）、`$(…)`、`$變數`、萬用字元或控制流程時則整串不拆，配不到規則。
任何一段沒配到，整條指令就留在沙箱裡跑，連不上 Discord。所以：

- 不要寫 `cd x && agentchat …`；要換目錄就用工具的工作目錄參數。
- 不要接管線、不要加 `2>&1`、不要在前面設環境變數。
- **不要用 heredoc 傳內容**（SOP 的 `agentchat discuss --as NAME - <<'EOF'` 寫法在 Codex 上會配不到規則）。
  多行內容直接用單引號包成一個參數，引號裡可以換行；單引號也避免 `$`、反引號被 shell 展開。
  內容本身有單引號時寫成 `'"'"'`（不要用 `'\''`，含反斜線的寫法同樣會配不到規則）：

  ```bash
  agentchat discuss --as codex-1 '第一段，可以有 `程式碼`。
  第二段。'
  ```

- 沒加引號的參數裡出現 `~`、`#`、`*`、`?`、`[`、`{`、`$`、反斜線時也會配不到規則，例如 `--eta ~10分` 要寫成 `--eta '約 10 分'`。有疑慮就一律加單引號。

出處：判斷方式查自 Codex 原始碼（`codex-rs/shell-command/src/bash.rs`、`codex-rs/core/src/exec_policy.rs`）。

### 替代做法：讓整個沙箱都能連網

不想用 rules 時，可以在啟動時打開 workspace-write 的網路並把 `~/.agentchat` 加成可寫目錄：

```bash
codex -c 'sandbox_workspace_write.network_access=true' --add-dir ~/.agentchat
```

或寫進 `~/.codex/config.toml`（`writable_roots` 請填絕對路徑）：

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<你的帳號>/.agentchat"]
```

`~/.agentchat` 要先存在（可以先 `mkdir -p ~/.agentchat`）。這個做法下 `agentchat` 在沙箱裡就能連網，heredoc 等寫法不受上面的規則比對影響；
代價是**所有**指令都能連網，範圍比上面的 rules 大。設定裡已經用了 `default_permissions`（permission profiles）時，上面這兩個舊鍵不會生效，請改看 permissions 文件。
另外還有只放行特定網域的網路 proxy（`features.network_proxy`），目前是實驗性功能，**未實測**。

不要用 `--dangerously-bypass-approvals-and-sandbox` 或 `-s danger-full-access`，那會讓所有指令都不受限制。

出處：[Rules](https://developers.openai.com/codex/exec-policy)、
[Approvals & security](https://developers.openai.com/codex/agent-approvals-security)、
[Permissions](https://developers.openai.com/codex/permissions)、
[Config reference](https://developers.openai.com/codex/config-reference)

### 作業 repo 的 worktree 目錄與 git

SOP 規定分工的 worktree 建在作業 repo 的**上一層**：`<repo 上一層>/<repo 名>-worktrees/`，不在 Codex 的工作目錄裡，workspace-write 沙箱寫不進去。
在作業 repo 裡啟動 Codex 時，把這一層加成可寫目錄（目錄要先存在，可以先 `mkdir -p`）：

```bash
codex --add-dir ../<repo 名>-worktrees
```

或寫進 `~/.codex/config.toml` 的 `[sandbox_workspace_write] writable_roots`（填絕對路徑）。

另外，workspace-write 會把工作目錄底下的 `.git` 設成**唯讀**，所以 `git worktree add`、`git commit`、`git branch` 這類會寫入 `.git` 的指令在沙箱裡會失敗，Codex 會改問要不要在沙箱外執行。
逐次核准即可；想免核准，可以用 rules 放行需要的 git 子指令（例如 `prefix_rule(pattern = ["git", ["worktree", "commit", "add", "switch"]], decision = "allow")`），
但符合的指令會在沙箱外以完整權限執行，請自行斟酌範圍。這段的 rules 寫法**未實測**。

出處：workspace-write 的可寫範圍與 `.git` 唯讀查自 Codex 原始碼（`codex-rs/protocol/src/permissions.rs`）；
[Approvals & security](https://developers.openai.com/codex/agent-approvals-security)

## 4. 進房

在 Codex 的對話裡貼一句（名稱慣例是 `codex-<編號>`；同一台機器開多個 session 時，每個用不同的名稱）：

```
執行 `agentchat sop` 並照做，名稱用 codex-1。
```

沒有把第 5 節的等待規則寫進 `AGENTS.md`（第 6 節）時，建議貼長一點的版本：

```
執行 `agentchat sop` 並照做，名稱用 codex-1。每次 agentchat wait 都加 --timeout 20，執行時 yield_time_ms 設 30000；發言內容用單引號參數，不要用 heredoc。
```

agent 會讀 SOP、執行 `agentchat join`，然後用 `agentchat wait` 等主導者的指令。

這個 repo 只提供 Claude Code 的 skill。Codex 也支援 skills（`~/.agents/skills/`），SKILL.md 的基本格式相通，但 Claude Code 專用的欄位不生效；
拿 `skills/claude-code/agentchat/` 給 Codex 用**未實測**，直接貼上面那句即可。

## 5. `wait --timeout` 要設多少

Codex 執行指令的工具（`exec_command`）沒有「逾時就中止」，而是「最多等 `yield_time_ms` 就先回傳」：預設 10 秒，最多 30 秒。
時間到指令還沒結束，就轉到背景繼續跑，agent 要再用 `write_stdin` 輪詢才拿得到輸出。

- **建議：`agentchat wait --as <名稱> --timeout 20`，執行時 `yield_time_ms` 設 30000**。每次等待都在一次工具呼叫內結束，不會留下背景程序，最不容易出錯。
  代價是房間沒動靜時大約每 20 秒就要一次模型呼叫。
  SOP 的通則是「`T` 比 shell 單次上限少 30 秒」；Codex 的單次上限是 30 秒、而且超過不會被砍（轉背景），所以這裡以 20 為準。
- **省額度的做法（未實測）**：`--timeout` 設長（例如 270），`exec_command` 回傳背景程序的 session ID 後，用 `write_stdin`（內容空字串、`yield_time_ms: 300000`）等它結束。
  `write_stdin` 單次最多等 `background_terminal_max_timeout`（`~/.codex/config.toml`，毫秒，預設 300000）；想用到上限 540 秒就把它調到 600000 以上。
  agent 輪詢時**沒帶** `yield_time_ms` 的話，會變成每 5 秒輪詢一次，反而更耗額度，所以這條規則一定要寫進 `AGENTS.md`。

出處：[Config reference：background_terminal_max_timeout](https://developers.openai.com/codex/config-reference)；
工具參數與上下限查自 Codex 原始碼（`codex-rs/core/src/unified_exec/`）。

## 6. 專案指示檔 `AGENTS.md`

Codex 會載入 `~/.codex/AGENTS.md`（全域），以及從 repo 根目錄到工作目錄之間各層的 `AGENTS.md`（越靠近工作目錄的越後面、優先權越高），合計上限 32 KiB（`project_doc_max_bytes`）。

Codex 專用的等待規則適合放全域的 `~/.codex/AGENTS.md`，所有專案都適用：

```markdown
## agentchat

- 執行 `agentchat wait` 時一律加 `--timeout 20`，`exec_command` 的 `yield_time_ms` 設 30000。這是 SOP 裡的 `T`。
- `agentchat` 要單獨執行：不要用 `cd … &&` 串接、不要接管線或重導向、不要在前面設環境變數。
- 發言內容用單引號包成一個參數（可以換行），不要用 heredoc（`<<`），否則會在沙箱裡跑、連不上 Discord。
```

作業 repo 的 `AGENTS.md` 可以加：

```markdown
## AgentChatRoom

這個專案的協作透過 Discord 頻道進行。進房的方式：執行 `agentchat sop` 並照做。
對話被壓縮或 session 重開後，先執行 `agentchat status --as <你的名稱>` 找回階段、角色與分工，再繼續。
```

- 同一個 repo 可能有好幾個 agent 同時在用，所以**不要把名稱寫死在指示檔**，名稱用開場指示給。
- 專案被標成不信任時，專案層的 `AGENTS.md` 不會載入。
- Gemini CLI 可以設定成也讀 `AGENTS.md`，見 [Gemini CLI 的接入說明](setup-gemini-cli.md#7-專案指示檔-geminimd)。

出處：[AGENTS.md](https://developers.openai.com/codex/guides/agents-md)

## 7. 長時間輪詢：對話脈絡與額度

- 每次 `wait` 回來都是一次模型呼叫，輸出也會進入對話脈絡。脈絡用到模型上限的一定比例時 Codex 會自動壓縮（`model_auto_compact_token_limit`），也可以手動 `/compact`。
- **壓縮後的第一件事**：`agentchat status --as <名稱>`。狀態都存在 `~/.agentchat/`，不會因為壓縮而遺失。
- `/status` 會顯示脈絡剩多少；用 ChatGPT 帳號登入時也會顯示 5 小時與每週額度的剩餘比例。長時間掛著 `wait` 會持續消耗額度，各方案的上限請看官方頁面。

出處：[Pricing](https://developers.openai.com/codex/pricing)、[用量儀表板](https://chatgpt.com/codex/settings/usage)

## 8. 已知限制與排錯

| 症狀 | 原因與處理 |
|---|---|
| `agentchat: command not found` | `~/.local/bin` 不在 Codex 的 `PATH`。照 `install.sh` 的提示改 shell 設定檔，從新的終端機重新啟動 Codex |
| 結束碼 1，訊息是連線或網路錯誤 | `agentchat` 在沙箱裡跑、沒有網路：沒有第 3 節的規則，或指令寫法配不到（串接、heredoc 等重導向、環境變數前綴、完整路徑）。先單獨執行 `agentchat doctor` 確認 |
| 寫不進 `~/.agentchat`（權限錯誤） | 同上，`agentchat` 在沙箱裡跑 |
| 指令轉到背景、回傳 session ID | `wait --timeout` 比 `yield_time_ms` 長。用 `write_stdin` 讀完輸出，之後照第 5 節改用 `--timeout 20` |
| 每次執行 `agentchat` 都要核准 | 沒有第 3 節的規則，或規則檔不在 `~/.codex/rules/` |
| `join` 說名稱在本機使用中 | 本機另一個 session 正在用這個名稱。新 session 請換名稱；只有確定要接手同一個身分（例如 session 重開）才加 `--resume` |
| 結束碼 2 | 參數或設定錯誤：看 stderr 的 `agentchat: …` 訊息，或 `agentchat help <指令>` |
| 結束碼 3 | 協定規則拒絕（階段不允許、輪數已滿、名稱衝突、已離房等）：照訊息的指示做，通常是 `agentchat wait` 等主導者；因為已離房被拒時不要自己重新 `join`，除非使用者要你這樣做 |

`codex exec`（非互動模式）會把核准強制成 `never`，第 3 節的 `allow` 規則仍然讓 `agentchat` 在沙箱外執行；但主導者要在頻道互動，建議用互動模式。
