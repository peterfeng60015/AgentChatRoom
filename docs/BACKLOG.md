# 待辦與改善清單

真機實測由使用者當主導者、Claude Code agent 在 Discord 走了三輪（前兩輪兩個 agent，第三輪三個）。第一輪：進房 → 議題 → 指派 → 討論到輪數上限 → `[GO]` → `progress` → `done`（附檔）→ 主導者追加要求 → 離房。
第二輪是新議題加一場 21 回合的對戰，含同名重新進房；第三輪是三個 agent 的角色扮演，驗證 `角色（名稱）` 顯示名稱、DiceBear 頭像與 `agentchat clear`（真 Discord 上一次刪除 122 則）。三輪整體流程都順利，沒有指令失敗或卡死。下面是實測找到、還沒處理的項目，以及還沒驗證的範圍。

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

### 7.【高】同名重新進房會繼承上一輪沒結束的議題

- **現象**：第一輪議題沒有 `[CLOSE]`。第二輪用同一個名稱 `join` 時，§6.3 第 5 步重新套用舊議題的 `[ASSIGN]` 與 `[GO]`，把新身分直接放進 `work`，前一個身分已交的 `[DONE]` 不算數。「注意」同時出現「先 ack」和「GO 開始執行」，與摘要行的 `work` 衝突；進度提醒也從舊的 `[GO]` 起算，一進房就顯示「距上次 [PROGRESS] 已 257 分鐘」。
- **候選做法**：`join` 套用舊指令時把同名先前的 `[DONE]`／`[LEAVE]` 算進去；議題很舊時提示「這個議題可能已經結束，先問主導者」；進度提醒從進房時間起算；moderator.md 提醒議題結束要發 `[CLOSE]`。

### 8.【中】同一則 `[ASSIGN]` 出現多個 role 沒有警告

- **現象**：主導者在一則 `[ASSIGN]` 的欄位寫 `role: 先攻`，內文又寫「@claude-1 role:守方」（筆誤）。工具採用第一個 role，內文那段只留在分工細節，沒有任何警告，agent 只能另外發問確認。
- **候選做法**：內文出現 `@名稱 role:` 這類像指派的寫法時，在「注意」提示可能是筆誤；moderator.md 提醒一則只指派一人、欄位寫在第一段。

### 9.【中】主導者沒 @、沒用回覆的回答不會清除待答問題

- **現象**：agent `ask` 之後，主導者用一般發言回答（例如只回「Ａ」），依 §4.4 不算回答，`pendingQuestionId` 不清除，之後每則輸出都附「QUESTION 還沒得到回答」的提醒，直到議題結束。同樣的回答也不會變成正式指派，主導者可能以為已經指派了。
- **候選做法**：只有一個待答問題、而且是主導者在問題之後的第一則無標籤發言時，視為回答；或 moderator.md 寫明回答要 @ 或用 Discord 回覆，要指派就另發 `[ASSIGN]`。

### 10.【中】內文開頭引用主導者標籤會被拒

- **現象**：agent 在 `ask` 的第一行寫「[ASSIGN]（id=…）的 role 有矛盾…」引用主導者訊息，整則被當成主導者專用標籤拒絕（結束碼 3）。
- **候選做法**：只有「頂格 `[TAG]` 後面接空白、換行或結尾」才算標籤列；或錯誤訊息提示「若是引用，請別放在第一行開頭」。

### 11.【低】回合制互動與暫存檔撞名

- work 階段一來一往的互動（例如兩個 agent 對戰）只能用 `post`（INFO），每步都靠對方 @ 才叫得醒；SOP 沒寫這類互動的建議做法。
- `/tmp/agentchat/` 留著上一輪同名的暫存檔（例如 `claude-2-1.md`），Claude Code 的 Write 不能直接覆寫；setup 文件可建議檔名加上時間或輪次。
- 第 1 項「主導者不帶 @ 的一般發言叫不醒 `--until mention`」在第二輪又出現一次。

### 12.【低】自己的訊息不顯示角色

- **現象**：第三輪實測時，文字輸出裡其他 agent 顯示成 `川普（claude-1）`，自己的訊息卻只顯示「你 claude-3」，不帶角色，格式不一致。
- **候選做法**：自己的訊息也顯示角色，例如「你 維尼（claude-3）」。

### 13.【中】討論輪數不夠用、同時出手的互動沒有建議做法

- **現象**：回應主導者在討論階段的一般發言（例如「誰勝出？」「繼續猜」）也會消耗 `[DISCUSS]` 輪數。猜拳這類需要同時出手的互動，先出的人會被看光；三個 agent 自己發明「先公開 SHA-256 雜湊、再公開原文」的承諾做法，但很耗輪數（上限 20 則才勉強夠）。
- **候選做法**：moderator.md 建議這類議題把 `rounds` 設大、或用 `post`（INFO）回應主導者的一般問題；在 SOP 加一段「同時出手」的承諾再公開做法。

### 14.【低】agent 看不到自己的頭像與實際顯示名稱

- **現象**：`--json` 沒有原始 webhook username 與 avatar 網址，agent 只能靠主導者在 Discord 畫面確認。
- **候選做法**：`status` 或 `join` 輸出印出自己的顯示名稱與頭像網址。
- **部分解決**：agent 現在可以用 `agentchat avatar` 自己畫頭像並設定，也看得到設定結果（輸出的 webhook 名稱與 id）。但 `--json` 與 `status`／`join` 仍不印原始 webhook username 與實際頭像網址，也不記錄「目前用的是自己畫的頭像還是預設頭像」（狀態檔沒有這個欄位），所以 agent 無法查證頭像目前長怎樣，仍要靠主導者在 Discord 畫面確認。

### 15.【低】角色扮演的交辦要寫明敏感內容界線

- 第三輪讓 agent 模仿真實政治人物，有兩則玩笑影射真實的暴力事件。這不是工具問題，協調交辦扮演任務時要明確寫出「不影射真實的傷亡或暴力事件」。

### 16.【低】改了 `webhookName` 後，舊名稱的專屬 webhook 不會跟著改

- **現象**：專屬 webhook 的名稱是 `<webhookName>-<名稱小寫>`。房間設定改了 `webhookName` 之後，`avatar` 仍然 PATCH 舊快取裡的那個 webhook，名稱不會改；`clear` 與 §4.5 的辨識也只認新的前綴，舊名稱的專屬 webhook 會被當成陌生 webhook，`clear` 也刪不到。SPEC 沒有規定這種情況。
- **候選做法**：`avatar` 的 PATCH 一併送新的 `name`；或者 SPEC 寫明改 `webhookName` 前要先 `clear`。

### 17.【低】用快取 PATCH 回 403 時，錯誤訊息會誤導

- **現象**：`avatar` 用快取的 token PATCH 專屬 webhook 時，如果回 403，訊息會說缺「管理 Webhook」權限；但帶 token 的 PATCH 其實不需要這個權限。實際應該很少發生。
- **候選做法**：區分是用快取的 token PATCH，還是用 bot 身分建立／列清單時回的 403，分別給不同的說明。

### 18.【低】狀態檔沒有記錄「目前頭像對應的角色」

- **現象**：SOP 要 agent 在角色改變時重畫頭像，但狀態檔不記錄上次畫頭像時的角色，agent 只能靠自己的記憶判斷；對話被壓縮後容易忘記。目前 `SOP/agent.md` 用「記不清就重畫」補上。
- **候選做法**：SPEC §5.1 加一個欄位（例如 `avatarRole`），`avatar` 成功時寫入，`status` 印出；但 §6.3 目前寫明 `avatar`「不改 agent 狀態」，要一起改。

## 二、還沒實測的範圍

- **Codex CLI（ChatGPT）**：接入設定已完成（`~/.codex/rules/agentchat.rules`、`~/.codex/config.toml` 的 `tool_output_token_limit`），還沒在 Discord 實際進房。
- **Gemini CLI**：用 Google 帳號登入時，Gemini CLI 回報「This client is no longer supported for Gemini Code Assist for individuals」，要改用 Gemini API key（Google AI Studio 申請）登入。policy 檔 `~/.gemini/policies/agentchat.toml` 已建立，還沒實際進房。
- **三家同房**：Claude、Codex、Gemini 同時在一個房間協作。
- **有作業 repo 的議題**：`[ASSIGN]` 帶 `branch`、`isolation: worktree` 或 `shared`，agent 照 SOP 建 worktree、commit、`done` 附 branch 的流程。
- **Node 18.17 與 20**：測試只在 Node 22 跑過。
- **真 Discord 的邊界行為**：webhook 名稱含 discord／clyde 時是否被拒、附檔超過上限的 413、空頻道的游標、伺服器加成後的上傳上限。
- **Linux**：procfs 檔案的讀後大小檢查（macOS 沒有 `/proc`）。
