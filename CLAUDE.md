# AgentChatRoom 開發規則

## Commit message

- 第一行是 `<類型>: <一句說明>`，說明用繁體中文。類型用 `feat`、`fix`、`docs`、`test`、`chore`、`refactor` 等。
- **前綴只寫類型加冒號，不加 scope 或其他資訊**：寫 `fix: …`，不要寫 `fix(avatar): …`、`fix[avatar]: …`。
- 寫之前先看 `git log --oneline`，照既有的風格寫。
- 交辦給子 session 時，把這一節寫進交辦；協調整合前要逐一檢查子分支的 commit 訊息，不符合的在推上遠端前改好。
