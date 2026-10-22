# 待辦與改善清單

第一次真機實測由使用者當主導者，兩個 Claude Code agent（claude-1、claude-2）在 Discord 走完一輪：進房 → 議題 → 指派 → 討論到輪數上限 → `[GO]` → `progress` → `done`（附檔）→ 主導者追加要求 → 離房。
整體流程順利，沒有指令失敗或卡死。下面是實測找到、還沒處理的項目，以及還沒驗證的範圍。

改善項目動到規格時，先改 `docs/SPEC.md`，再改程式、SOP 與測試。

## 一、實測找到的改善項目

### 1.【高】done 之後漏接主導者的追加要求

- **現象**：agent `done` 之後照 SOP 3.3 用 `wait --until mention` 等。主導者接著發不帶 @ 的 `[GO]`（例如「各自再交兩張圖」），以及只寫角色名、不帶 @ 的催促（例如「台中人 你還沒交」），都沒有叫醒 agent，要等到逾時才看到；其中一個 agent 因此晚交約 1 分鐘。
- **原因**：
  - 照 §4.4，不帶 @ 的 `[GO]` 對已經 `done` 的 agent 不生效，所以不算 `targetsMe`。
  - 只寫角色名、沒有 `@` 的訊息不算 `mentionsMe`。
  - `--until mention` 只在 `mentionsMe` 或 `targetsMe` 時結束，逾時的狀態行只寫「逾時，有 N 則其他新訊息」，沒有「注意」提示。
- **候選做法**（擇一或併用）：
  - `--until mention` 也把主導者的任何發言當成符合條件。
  - `done` 階段建議的等法改成 `--until moderator`。
  - 主導者發的指令對我不生效時，在「注意」加一行說明（例如「主導者發了 [GO]，但你已完成，對你不生效；若內文是對全體的要求，照內文處理」）。
  - `SOP/moderator.md` 寫明：要已完成的 agent 繼續做事時，要 @ 它們或用 `@all`。

### 2.【中】輪數已滿後，主導者的一般發言要怎麼回

- **現象**：討論輪數用完後，主導者用無標籤的一般發言要大家「多講講其他觀點」。一個 agent 用 `post` 回答，另一個發 `[DISCUSS]`。
- **候選做法**：SOP 舉例說明「輪數已滿時，主導者的一般提問用 `post` 回答；要再討論應等 `[CONTINUE]`」；或工具在輪數已滿時提示這點。

### 3.【中】兩個 agent 同時發言會撞文

- **現象**：兩個 agent 幾乎同時發 `[DISCUSS]`，內容重疊。「未讀：N 則」提示只在送出之後才出現。
- **候選做法**：`discuss` 送出前先檢查游標之後有沒有未讀，有就拒絕或警告，提示先 `wait --timeout 0` 讀完再發。

### 4.【中】`agentchat sop` 在 Claude Code 會被截斷

- **現象**：SOP 全文約 46 KB，Claude Code 把輸出存成檔案只給預覽，或截掉中間一段。agent 照 SOP 開頭的提醒，改用 `agentchat sop --path` 加讀檔工具讀完，所以沒有卡住，但第一次一定會撞到。
- **候選做法**：
  - `setup-claude-code.md` 直接建議用 `agentchat sop --path` 加 Read 讀全文。
  - 或把 SOP 拆成「快速版」與「完整版」。

### 5.【低】done 之後的長時間等待很耗脈絡與額度

- **現象**：`done` 之後每 90 秒一輪 `wait`，連續十幾輪都是逾時，每一輪都佔用 agent 的脈絡與 Claude 額度。
- **候選做法**：`done` 階段建議較長的 `T`、`idleLimitMin` 只在 `done` 階段縮短，或 `done` 之後一段時間沒有新指示就自動 `leave`。

### 6.【低】文件小缺口

- `SOP/agent.md` 3.2 沒有描述 `wait` 輸出裡兩則訊息之間的 `---` 分隔線。
- 主導者要求交圖時，agent 沒有現成的產圖工具。實測時 agent 先寫 SVG，再用 macOS 的 `qlmanage -t` 轉 PNG。setup 文件可以補一段產圖做法。

## 二、還沒實測的範圍

- **Codex CLI（ChatGPT）**：接入設定已完成（`~/.codex/rules/agentchat.rules`、`~/.codex/config.toml` 的 `tool_output_token_limit`），還沒在 Discord 實際進房。
- **Gemini CLI**：用 Google 帳號登入時，Gemini CLI 回報「This client is no longer supported for Gemini Code Assist for individuals」，要改用 Gemini API key（Google AI Studio 申請）登入。policy 檔 `~/.gemini/policies/agentchat.toml` 已建立，還沒實際進房。
- **三家同房**：Claude、Codex、Gemini 同時在一個房間協作。
- **有作業 repo 的議題**：`[ASSIGN]` 帶 `branch`、`isolation: worktree` 或 `shared`，agent 照 SOP 建 worktree、commit、`done` 附 branch 的流程。
- **Node 18.17 與 20**：測試只在 Node 22 跑過。
- **真 Discord 的邊界行為**：webhook 名稱含 discord／clyde 時是否被拒、附檔超過上限的 413、空頻道的游標、伺服器加成後的上傳上限。
- **Linux**：procfs 檔案的讀後大小檢查（macOS 沒有 `/proc`）。
