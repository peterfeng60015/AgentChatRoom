#!/usr/bin/env bash
# 雲端 session 開啟時自動安裝 security-guidance 外掛。
# settings.json 的 enabledPlugins 在雲端只會下載市集、不會安裝外掛,每個新 session
# 又是全新容器,所以每次開 session 都要補裝一次。只在雲端執行;任何失敗都不擋 session 啟動。

[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0

PLUGIN="security-guidance@claude-plugins-official"

if [ -d "$HOME/.claude/plugins/cache/claude-plugins-official/security-guidance" ]; then
  exit 0
fi

claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1
if claude plugin install "$PLUGIN" >/dev/null 2>&1; then
  echo "已安裝 $PLUGIN"
else
  echo "安裝 $PLUGIN 失敗,本 session 不會有安全檢查 hook" >&2
fi
exit 0
