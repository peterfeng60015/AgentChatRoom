#!/usr/bin/env bash
# scripts/install.sh 的情境測試。npm test 透過 install.test.js 執行；也可以直接跑：
#   bash test/install/run.sh [install.sh 的路徑]
# 每個情境都在暫存目錄裡建一份假 repo（bin/agentchat.js 是假的，不依賴真正的實作）與假 HOME，
# 路徑刻意含空白；不碰真正的 HOME，結束時刪掉暫存目錄。全部通過時結束碼 0。
#
# 全部情境在 C 與 UTF-8 locale 下各跑一次：macOS 的 bash 3.2 在 UTF-8 下對「變數緊接全形字」的處理不同，
# 只在 C locale 測會漏掉。本檔自己也遵守同樣的寫法（變數後面接非 ASCII 字元時寫成 ${var}）。
set -uo pipefail
unset CDPATH
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_SCRIPT="${1:-$HERE/../../scripts/install.sh}"
SRC_SCRIPT="$(cd -P "$(dirname "$SRC_SCRIPT")" && pwd)/$(basename "$SRC_SCRIPT")"
if [ ! -f "$SRC_SCRIPT" ]; then
  echo "找不到 ${SRC_SCRIPT}" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node" >&2
  exit 2
fi
# 用實體路徑：macOS 的 /tmp、/var 是 symlink，install.sh 會把 repo 路徑轉成實體路徑，比對時兩邊要一致。
T="$(cd -P "$(mktemp -d "${TMPDIR:-/tmp}/agentchat-install-test.XXXXXX")" && pwd)"
# 有些情境會拿掉目錄的寫入權限，清理前先還原。
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
NODE_DIR="$(dirname "$(command -v node)")"
BASE_PATH="/usr/bin:/bin:/usr/sbin:/sbin:$NODE_DIR"
pass=0
failn=0
LOC=C
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$*"; }
ng() { failn=$((failn + 1)); printf '  FAIL [%s] %s\n' "$LOC" "$*"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else ng "$desc"; fi; }

new_env() {
  # 產生一份全新的假 repo 與 HOME（路徑含空白）
  chmod -R u+w "$T/case" 2>/dev/null
  rm -rf "$T/case"
  mkdir -p "$T/case"
  R="$T/case/my repo"
  H="$T/case/home dir"
  mkdir -p "$R/scripts" "$R/bin" "$R/skills/claude-code/agentchat" "$R/skills/agents/agentchat" "$R/skills/gemini-cli" "$R/config" "$H"
  cp "$SRC_SCRIPT" "$R/scripts/install.sh"
  printf '#!/usr/bin/env node\nconsole.log("fake agentchat ok")\n' > "$R/bin/agentchat.js"
  chmod 644 "$R/bin/agentchat.js"
  printf -- '---\nname: agentchat\ndescription: test\n---\n' > "$R/skills/claude-code/agentchat/SKILL.md"
  printf -- '---\nname: agentchat\ndescription: test\n---\n' > "$R/skills/agents/agentchat/SKILL.md"
  printf 'prompt = "test {{args}}"\n' > "$R/skills/gemini-cli/agentchat.toml"
  printf 'DISCORD_BOT_TOKEN=\n' > "$R/.env.example"
  printf '{}\n' > "$R/config/room.json"
}
# 參數交給 install.sh；輸出存到 OUT，結束碼存到 RC。TPATH、TSHELL 可以覆寫 PATH 與 SHELL。
run_inst() {
  OUT="$(cd / && env -u CLAUDE_CONFIG_DIR -u AGENTCHAT_STATE_DIR HOME="$H" PATH="${TPATH:-$BASE_PATH}" SHELL="${TSHELL-/bin/zsh}" LC_ALL="$LOC" bash "$R/scripts/install.sh" "$@" 2>&1)"
  RC=$?
}
tree_snapshot() {
  (cd "$H" && find . -print0 | sort -z | xargs -0 ls -ld 2>/dev/null | awk '{print $1, $NF}')
  (cd "$R" && find . -print0 | sort -z | xargs -0 ls -ld 2>/dev/null | awk '{print $1, $NF}')
}
link_is() { [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; }
has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
hasnt() { ! has "$1"; }

scenarios() {
echo "== 1. dry-run 在乾淨的 HOME"
new_env; before="$(tree_snapshot)"; run_inst --dry-run
check "dry-run 結束碼 0" [ "$RC" -eq 0 ]
check "dry-run 不改任何檔案（含 repo）" [ "$before" = "$(tree_snapshot)" ]
check "dry-run 列出要建的連結" has "[將連結] $H/.local/bin/agentchat -> $R/bin/agentchat.js"
check "dry-run 列出 chmod" has "[將設定] chmod +x"
check "dry-run 提示 PATH" has "不在 PATH"
check "dry-run 不印下一步" hasnt "安裝完成"

echo "== 2. 安裝"
run_inst
check "安裝結束碼 0" [ "$RC" -eq 0 ]
check "agentchat 連結指向 repo" link_is "$H/.local/bin/agentchat" "$R/bin/agentchat.js"
check "skill 連結指向 repo" link_is "$H/.claude/skills/agentchat" "$R/skills/claude-code/agentchat"
check "bin/agentchat.js 可執行" [ -x "$R/bin/agentchat.js" ]
check "沒有建立 .env" [ ! -e "$R/.env" ]
check "PATH 警告與修正方法" has 'export PATH="$HOME/.local/bin:$PATH"'
check "下一步提到 cp .env.example" has "cp \"$R/.env.example\" \"$R/.env\""
check "PATH 沒設好時下一步提醒開新終端機" has "開新的終端機後執行 agentchat doctor"
check "skill 透過連結讀得到 SKILL.md" [ -f "$H/.claude/skills/agentchat/SKILL.md" ]
check "Codex／Gemini 共用 skill 連結指向 repo" link_is "$H/.agents/skills/agentchat" "$R/skills/agents/agentchat"
check "共用 skill 透過連結讀得到 SKILL.md" [ -f "$H/.agents/skills/agentchat/SKILL.md" ]
check "Gemini 指令連結指向 repo" link_is "$H/.gemini/commands/agentchat.toml" "$R/skills/gemini-cli/agentchat.toml"
check "Gemini 指令透過連結讀得到內容" grep -qF '{{args}}' "$H/.gemini/commands/agentchat.toml"
check "動作是做完才印" has "[連結] $H/.local/bin/agentchat -> $R/bin/agentchat.js"

echo "== 3. 重複安裝（PATH 已含 ~/.local/bin、已有 .env）"
printf 'DISCORD_BOT_TOKEN=x\n' > "$R/.env"; envsum="$(cksum < "$R/.env")"
TPATH="$H/.local/bin:$BASE_PATH" run_inst
check "重複安裝結束碼 0" [ "$RC" -eq 0 ]
check "顯示已指向本 repo" has "已指向本 repo，不變"
check "沒有 PATH 警告" hasnt "不在 PATH"
check "沒有遮蔽警告" hasnt "會先被找到"
check ".env 沒被改" [ "$envsum" = "$(cksum < "$R/.env")" ]
check "已有 .env 時不叫人 cp" hasnt "cp \""
check "下一步直接執行 doctor" has "3. 執行 agentchat doctor"
check "agentchat 指令可執行" [ "$(HOME="$H" PATH="$H/.local/bin:$BASE_PATH" agentchat)" = "fake agentchat ok" ]
before="$(tree_snapshot)"; TPATH="$H/.local/bin:$BASE_PATH" run_inst --dry-run
check "已安裝後 dry-run 只顯示 [OK]" has "已指向本 repo，不變"
check "已安裝後 dry-run 沒有要做的連結" hasnt "[將連結]"
check "已安裝後 dry-run 不改檔案" [ "$before" = "$(tree_snapshot)" ]

echo "== 4. PATH 裡有另一個 agentchat 排在前面"
mkdir -p "$T/case/other"; printf '#!/bin/sh\necho other\n' > "$T/case/other/agentchat"; chmod +x "$T/case/other/agentchat"
TPATH="$T/case/other:$H/.local/bin:$BASE_PATH" run_inst
check "結束碼 0" [ "$RC" -eq 0 ]
check "警告被遮蔽" has "PATH 裡排在 $H/.local/bin 前面的 $T/case/other/agentchat 會先被找到"
TPATH="$T/case/other:$H/.local/bin:$BASE_PATH" run_inst --dry-run
check "dry-run 也警告被遮蔽" has "$T/case/other/agentchat 會先被找到"
TPATH="$H/.local/bin:$T/case/other:$BASE_PATH" run_inst
check "另一個 agentchat 排在後面時不警告" hasnt "會先被找到"
new_env; mkdir -p "$T/case/other"; printf '#!/bin/sh\necho other\n' > "$T/case/other/agentchat"; chmod +x "$T/case/other/agentchat"
TPATH="$H/.local/bin:$T/case/other:$BASE_PATH" run_inst --dry-run
check "還沒安裝、另一個排在後面時 dry-run 不誤報" hasnt "會先被找到"
TPATH="$T/case/other:$BASE_PATH" run_inst --dry-run
check "不在 PATH 而且有別的 agentchat 時說會執行到它" has "現在打 agentchat 會執行到 $T/case/other/agentchat"
check "不在 PATH 而且有別的 agentchat 時不說找不到" hasnt "會找不到指令"
OUT="$(cd "$H/.local/bin" 2>/dev/null || mkdir -p "$H/.local/bin"; cd "$H/.local/bin" && HOME="$H" PATH=".:$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" --dry-run 2>&1)"
check "PATH 只有相對的 . 時不當成 ~/.local/bin" has "不在 PATH"

echo "== 5. 目標被一般檔案占用"
new_env; mkdir -p "$H/.local/bin"; echo mine > "$H/.local/bin/agentchat"
before="$(tree_snapshot)"; run_inst
check "結束碼 1" [ "$RC" -eq 1 ]
check "說明一般檔案、不覆蓋" has "已存在而且是一般檔案（不是 symlink），不覆蓋"
check "檔案內容沒變" [ "$(cat "$H/.local/bin/agentchat")" = "mine" ]
check "沒有做任何變更（skill 也沒裝、沒 chmod）" [ "$before" = "$(tree_snapshot)" ]
check "提示沒做任何變更" has "沒有做任何變更"

echo "== 6. skill 目標是一般目錄"
new_env; mkdir -p "$H/.claude/skills/agentchat"; echo x > "$H/.claude/skills/agentchat/SKILL.md"
before="$(tree_snapshot)"; run_inst
check "結束碼 1" [ "$RC" -eq 1 ]
check "說明一般目錄" has "已存在而且是一般目錄"
check "沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]

echo "== 7. 既有 symlink 指向別處、或是斷掉的連結 → 取代"
new_env; mkdir -p "$H/.local/bin" "$H/.claude/skills"
ln -s /nonexistent/old-clone/bin/agentchat.js "$H/.local/bin/agentchat"; ln -s "$T" "$H/.claude/skills/agentchat"
before="$(tree_snapshot)"; run_inst --dry-run
check "dry-run 顯示將取代" has "[將取代] $H/.claude/skills/agentchat -> $R/skills/claude-code/agentchat（原本指向 ${T}）"
check "dry-run 取代時不改檔案" [ "$before" = "$(tree_snapshot)" ]
run_inst
check "結束碼 0" [ "$RC" -eq 0 ]
check "斷掉的連結被取代" link_is "$H/.local/bin/agentchat" "$R/bin/agentchat.js"
check "指向別處的目錄連結被取代（不是建在目錄裡）" link_is "$H/.claude/skills/agentchat" "$R/skills/claude-code/agentchat"
check "沒有在別處目錄裡建連結" [ ! -e "$T/agentchat" ]
check "顯示取代" has "[取代] $H/.local/bin/agentchat -> $R/bin/agentchat.js（原本指向 /nonexistent/old-clone/bin/agentchat.js）"
check "取代不像 agentchat 的連結時警告" has "$H/.claude/skills/agentchat 原本指向 ${T}，看起來不是 agentchat 的連結"
check "取代另一份 clone 的連結時不警告" hasnt "原本指向 /nonexistent/old-clone/bin/agentchat.js，看起來不是"

echo "== 8. 父目錄是檔案、斷掉的連結、不可寫"
new_env; echo x > "$H/.claude"
before="$(tree_snapshot)"; run_inst
check "父目錄是檔案 → 結束碼 1" [ "$RC" -eq 1 ]
check "說明不是目錄" has "已存在但不是目錄"
check "沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
new_env; ln -s "$T/case/nowhere" "$H/.claude"
before="$(tree_snapshot)"; run_inst
check "祖先是斷掉的連結 → 結束碼 1" [ "$RC" -eq 1 ]
check "說明是斷掉的 symlink" has "$H/.claude 是斷掉的 symlink"
check "沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
new_env; mkdir -p "$H/.claude"; chmod 555 "$H/.claude"
before="$(tree_snapshot)"; run_inst
check "~/.claude 不可寫 → 結束碼 1" [ "$RC" -eq 1 ]
check "說明沒有寫入權限" has "沒有權限寫入 $H/.claude"
check "沒有只裝一半（agentchat 連結也沒建）" [ ! -L "$H/.local/bin/agentchat" ]
check "沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
chmod 755 "$H/.claude"

if [ "$(uname)" = Darwin ]; then
  new_env; chflags uchg "$R/bin/agentchat.js"
  run_inst
  check "chmod 失敗 → 結束碼 1" [ "$RC" -eq 1 ]
  check "chmod 失敗時說明" has "無法把 $R/bin/agentchat.js 設成可執行"
  check "chmod 失敗時沒有建任何連結" [ ! -e "$H/.local" ]
  chflags nouchg "$R/bin/agentchat.js"
  new_env; mkdir -p "$H/.local/bin"; ln -s /elsewhere/x "$H/.local/bin/agentchat"
  chmod +a "$(id -un) deny delete_child" "$H/.local/bin"
  run_inst
  check "預檢抓不到的失敗（ACL 禁止刪除）→ 結束碼非 0" [ "$RC" -ne 0 ]
  check "中途失敗時印出重跑說明" has "上一步失敗，已中止。前面印出的步驟都已完成"
  check "失敗的那一步沒有被印成已完成" hasnt "[取代] $H/.local/bin/agentchat"
  chmod -N "$H/.local/bin"
fi

echo "== 9. 解除安裝"
new_env; run_inst
before="$(tree_snapshot)"; run_inst --uninstall --dry-run
check "dry-run uninstall 結束碼 0" [ "$RC" -eq 0 ]
check "dry-run uninstall 不刪" [ "$before" = "$(tree_snapshot)" ]
check "dry-run uninstall 列出將移除" has "[將移除] $H/.local/bin/agentchat"
check "dry-run uninstall 結尾說明沒改檔案" has "dry-run 結束，沒有改任何檔案。"
run_inst --uninstall
check "uninstall 結束碼 0" [ "$RC" -eq 0 ]
check "agentchat 連結已刪" [ ! -L "$H/.local/bin/agentchat" ]
check "skill 連結已刪" [ ! -L "$H/.claude/skills/agentchat" ]
check "共用 skill 連結已刪" [ ! -L "$H/.agents/skills/agentchat" ]
check "Gemini 指令連結已刪" [ ! -L "$H/.gemini/commands/agentchat.toml" ]
check "repo 的 skill 目錄還在" [ -f "$R/skills/claude-code/agentchat/SKILL.md" ]
check "repo 的共用 skill 還在" [ -f "$R/skills/agents/agentchat/SKILL.md" ]
check "repo 的 Gemini 指令還在" [ -f "$R/skills/gemini-cli/agentchat.toml" ]
check "父目錄保留" [ -d "$H/.local/bin" ]
check "提到本機狀態目錄預設位置" has "本機狀態目錄 ~/.agentchat"
run_inst --uninstall
check "再 uninstall 一次結束碼 0" [ "$RC" -eq 0 ]
check "顯示不存在略過" has "不存在"
OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" AGENTCHAT_STATE_DIR=/custom/state LC_ALL="$LOC" bash "$R/scripts/install.sh" --uninstall 2>&1)"
check "設了 AGENTCHAT_STATE_DIR 時提到它" has "本機狀態目錄 /custom/state"
run_inst; chmod 555 "$H/.local/bin"
before="$(tree_snapshot)"; run_inst --uninstall
check "~/.local/bin 不可寫時 uninstall 結束碼 1" [ "$RC" -eq 1 ]
check "說明沒有權限" has "沒有權限刪除 $H/.local/bin/agentchat"
check "沒有只刪一半（skill 連結還在）" [ -L "$H/.claude/skills/agentchat" ]
check "沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
chmod 755 "$H/.local/bin"

echo "== 10. uninstall 不刪別人的東西"
new_env; mkdir -p "$H/.local/bin" "$H/.claude/skills"; ln -s /elsewhere/agentchat.js "$H/.local/bin/agentchat"; mkdir "$H/.claude/skills/agentchat"
run_inst --uninstall
check "結束碼 0" [ "$RC" -eq 0 ]
check "別人的 symlink 保留" link_is "$H/.local/bin/agentchat" "/elsewhere/agentchat.js"
check "一般目錄保留" [ -d "$H/.claude/skills/agentchat" ]
check "目標不存在的連結說無法確認" has "目標不存在或無法解析，無法確認是不是這個 repo 建的，不刪"
new_env; mkdir -p "$H/.local/bin"; ln -s "$T/case/other-tool" "$H/.local/bin/agentchat"; mkdir -p "$T/case/other-tool"
run_inst --uninstall
check "指向別處（存在）的連結保留" link_is "$H/.local/bin/agentchat" "$T/case/other-tool"
check "說明不是這個 repo 建的" has "不是這個 repo 建的，不刪"

echo "== 11. 透過別名路徑、相對連結、連結鏈"
new_env; ln -s "$R" "$T/case/alias"
OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$T/case/alias/scripts/install.sh" 2>&1)"; RC=$?
check "透過 repo 別名執行 → 結束碼 0" [ "$RC" -eq 0 ]
check "連結指向實體路徑" link_is "$H/.local/bin/agentchat" "$R/bin/agentchat.js"
rm "$H/.local/bin/agentchat"; (cd "$H/.local/bin" && ln -s "../../../my repo/bin/agentchat.js" agentchat)
run_inst --uninstall
check "相對路徑連結也被認出並移除" [ ! -L "$H/.local/bin/agentchat" ]
run_inst; mkdir -p "$T/case/mid"; ln -s "$R/bin/agentchat.js" "$T/case/mid/agentchat.js"
rm "$H/.local/bin/agentchat"; ln -s "$T/case/mid/agentchat.js" "$H/.local/bin/agentchat"
run_inst --uninstall
check "連結鏈指到本 repo 時也移除" [ ! -L "$H/.local/bin/agentchat" ]
check "中間的連結不動" [ -L "$T/case/mid/agentchat.js" ]
new_env; ln -s "$R/scripts/install.sh" "$T/case/inst.sh"
OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$T/case/inst.sh" 2>&1)"; RC=$?
check "透過指向腳本檔的 symlink 執行 → 結束碼 0" [ "$RC" -eq 0 ]
check "透過腳本 symlink 執行時找到正確的 repo" link_is "$H/.local/bin/agentchat" "$R/bin/agentchat.js"
OUT="$(cd "$R" && HOME="$H" PATH="$BASE_PATH" LC_ALL="$LOC" bash scripts/install.sh 2>&1)"; RC=$?
check "在 repo 根目錄用相對路徑執行 → 結束碼 0" [ "$RC" -eq 0 ]
OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" LC_ALL="$LOC" bash < "$R/scripts/install.sh" 2>&1)"; RC=$?
check "從 stdin 執行 → 結束碼 2" [ "$RC" -eq 2 ]
check "從 stdin 執行時說明用法" has "不支援從 stdin 或管線執行"

echo "== 12. 大小寫不同的路徑（只在不分大小寫的檔案系統上測）"
new_env
if [ -d "$T/case/MY REPO" ]; then
  OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$T/case/MY REPO/scripts/install.sh" 2>&1)"; RC=$?
  check "用大寫路徑安裝 → 結束碼 0" [ "$RC" -eq 0 ]
  check "連結記下實際的大小寫" link_is "$H/.local/bin/agentchat" "$R/bin/agentchat.js"
  rm "$H/.local/bin/agentchat"; ln -s "$T/case/MY REPO/bin/agentchat.js" "$H/.local/bin/agentchat"
  run_inst
  check "大小寫不同但同一個檔案 → 視為已安裝" has "$H/.local/bin/agentchat 已指向本 repo，不變"
  run_inst --uninstall
  check "大小寫不同的舊連結也能移除" [ ! -L "$H/.local/bin/agentchat" ]
else
  echo "  （檔案系統分大小寫，略過）"
fi

echo "== 13. Node 檢查"
new_env; mkdir -p "$T/case/fakenode"
printf '#!/bin/sh\necho 18.16.1\n' > "$T/case/fakenode/node"; chmod +x "$T/case/fakenode/node"
before="$(tree_snapshot)"; TPATH="$T/case/fakenode:/usr/bin:/bin" run_inst
check "Node 18.16 → 結束碼 1" [ "$RC" -eq 1 ]
check "說明版本太舊" has "Node 18.16.1 太舊"
check "沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
printf '#!/bin/sh\necho 18.17.0\n' > "$T/case/fakenode/node"
TPATH="$T/case/fakenode:/usr/bin:/bin" run_inst
check "Node 18.17.0 → 結束碼 0" [ "$RC" -eq 0 ]
new_env; mkdir -p "$T/case/fakenode"; printf '#!/bin/sh\necho 9.99.0\n' > "$T/case/fakenode/node"; chmod +x "$T/case/fakenode/node"
TPATH="$T/case/fakenode:/usr/bin:/bin" run_inst
check "Node 9.99 → 結束碼 1" [ "$RC" -eq 1 ]
check "Node 9.99 說明太舊" has "Node 9.99.0 太舊"
printf '#!/bin/sh\necho 20\n' > "$T/case/fakenode/node"
TPATH="$T/case/fakenode:/usr/bin:/bin" run_inst
check "版本只有主版號 20 → 結束碼 0" [ "$RC" -eq 0 ]
new_env; mkdir -p "$T/case/fakenode"; printf '#!/bin/sh\necho garbage\n' > "$T/case/fakenode/node"; chmod +x "$T/case/fakenode/node"
TPATH="$T/case/fakenode:/usr/bin:/bin" run_inst
check "版本無法判斷 → 結束碼 1" [ "$RC" -eq 1 ]
check "說明無法判斷" has "無法判斷 Node 版本（node -p 回傳「garbage」）"
TPATH="/usr/bin:/bin" run_inst
check "沒有 node → 結束碼 1" [ "$RC" -eq 1 ]
check "說明找不到 node" has "找不到 node"
TPATH="/usr/bin:/bin" run_inst --uninstall
check "沒有 node 也能 uninstall" [ "$RC" -eq 0 ]

echo "== 14. 選項錯誤、repo 不完整、HOME 異常、root"
new_env; run_inst --bogus
check "不認得的選項 → 結束碼 2" [ "$RC" -eq 2 ]
run_inst --help
check "--help → 結束碼 0" [ "$RC" -eq 0 ]
rm "$R/bin/agentchat.js"; before="$(tree_snapshot)"; run_inst
check "缺 bin/agentchat.js → 結束碼 1" [ "$RC" -eq 1 ]
check "說明找不到" has "找不到 $R/bin/agentchat.js，確認 repo 是完整的 clone"
check "缺檔時沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
new_env; rm "$R/skills/agents/agentchat/SKILL.md"; before="$(tree_snapshot)"; run_inst
check "缺共用 skill → 結束碼 1" [ "$RC" -eq 1 ]
check "說明找不到共用 skill" has "找不到 $R/skills/agents/agentchat/SKILL.md，確認 repo 是完整的 clone"
check "缺共用 skill 時沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]
new_env; mkdir -p "$H/.gemini/commands"; echo 'prompt = "mine"' > "$H/.gemini/commands/agentchat.toml"
before="$(tree_snapshot)"; run_inst
check "已有自己的 Gemini 指令檔 → 結束碼 1" [ "$RC" -eq 1 ]
check "說明不覆蓋一般檔案" has "$H/.gemini/commands/agentchat.toml 已存在而且是一般檔案（不是 symlink），不覆蓋"
check "使用者的 Gemini 指令檔沒被改" grep -qF 'mine' "$H/.gemini/commands/agentchat.toml"
check "沒有只裝一半" [ "$before" = "$(tree_snapshot)" ]
OUT="$(cd / && env -u HOME PATH="$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"; RC=$?
check "HOME 未設定 → 結束碼 2" [ "$RC" -eq 2 ]
OUT="$(cd / && HOME="relative/home" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"; RC=$?
check "HOME 是相對路徑 → 結束碼 2" [ "$RC" -eq 2 ]
check "說明 HOME 要是絕對路徑" has "HOME 必須是絕對路徑（目前是「relative/home」）"
new_env
OUT="$(cd / && HOME="$T/case/no-such-home" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" --dry-run 2>&1)"; RC=$?
check "HOME 不存在時 dry-run 結束碼 0" [ "$RC" -eq 0 ]
check "HOME 不存在時警告" has "HOME（$T/case/no-such-home）不存在"
check "HOME 不存在時 dry-run 不建目錄" [ ! -e "$T/case/no-such-home" ]
OUT="$(cd / && HOME="$T/case/no-such-home" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"; RC=$?
check "HOME 不存在時仍可安裝" link_is "$T/case/no-such-home/.local/bin/agentchat" "$R/bin/agentchat.js"
echo x > "$T/case/home-file"
OUT="$(cd / && HOME="$T/case/home-file" PATH="$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"; RC=$?
check "HOME 是檔案 → 結束碼 2" [ "$RC" -eq 2 ]
new_env; mkdir -p "$T/case/fakeid"; printf '#!/bin/sh\necho 0\n' > "$T/case/fakeid/id"; chmod +x "$T/case/fakeid/id"
before="$(tree_snapshot)"; TPATH="$T/case/fakeid:$BASE_PATH" run_inst
check "以 root 執行但 HOME 屬於別人 → 結束碼 2" [ "$RC" -eq 2 ]
check "說明不要用 sudo" has "不要加 sudo"
check "root 被擋時沒有做任何變更" [ "$before" = "$(tree_snapshot)" ]

echo "== 15. CDPATH、HOME 與 PATH 的各種寫法"
new_env
OUT="$(cd "$T/case" && CDPATH="$T/case" HOME="$H" PATH="$BASE_PATH" LC_ALL="$LOC" bash "my repo/scripts/install.sh" 2>&1)"; RC=$?
check "設了 CDPATH、用相對路徑執行 → 結束碼 0" [ "$RC" -eq 0 ]
check "設了 CDPATH 時連結仍指向正確的 repo" link_is "$H/.local/bin/agentchat" "$R/bin/agentchat.js"
OUT="$(cd / && HOME="$H//" PATH="$H/.local/bin:$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"; RC=$?
check "HOME 結尾有多個 / → 結束碼 0" [ "$RC" -eq 0 ]
check "HOME 結尾有 / 時不誤報 PATH" hasnt "不在 PATH"
check "HOME 結尾有 / 時輸出沒有 //" hasnt "//"
for variant in "$H/.local/bin/" "$H/.local//bin" "$H/./.local/bin"; do
  TPATH="$variant:$BASE_PATH" run_inst
  check "PATH 寫成 ${variant#"$H"} 時不誤報" hasnt "不在 PATH"
done
ln -s "$H" "$T/case/home-alias"
OUT="$(cd / && HOME="$T/case/home-alias" PATH="$H/.local/bin:$BASE_PATH" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"; RC=$?
check "HOME 是別名、PATH 用實體路徑時不誤報" hasnt "不在 PATH"
mkdir -p "$T/case/same"; ln -s "$R/bin/agentchat.js" "$T/case/same/agentchat"
TPATH="$T/case/same:$H/.local/bin:$BASE_PATH" run_inst
check "排在前面的連結指向同一支程式時不誤報遮蔽" hasnt "會先被找到"

echo "== 16. PATH 修正提示依 shell 而定"
new_env; TSHELL=/bin/bash run_inst
check "bash 提示 ~/.bashrc" has "加到 ~/.bashrc（macOS 的登入 shell 讀 ~/.bash_profile）"
TSHELL=/usr/local/bin/fish run_inst
check "其他 shell 提示 shell 設定檔" has "加到 你的 shell 設定檔"
TSHELL= run_inst
check "SHELL 空白時提示 shell 設定檔" has "加到 你的 shell 設定檔"

echo "== 17. worktree 與 CLAUDE_CONFIG_DIR 提醒"
new_env; printf 'gitdir: /somewhere/.git/worktrees/x\n' > "$R/.git"
run_inst
check "worktree 時仍可安裝" [ "$RC" -eq 0 ]
check "worktree 時警告" has "這是 git worktree"
new_env; printf 'gitdir: ../.git/modules/agentchat\n' > "$R/.git"
run_inst
check "submodule 時不警告 worktree" hasnt "git worktree"
new_env
OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" CLAUDE_CONFIG_DIR="$T/case/claude-config" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"
check "CLAUDE_CONFIG_DIR 在別處時警告並給連結指令" has "ln -sfn \"$R/skills/claude-code/agentchat\" \"$T/case/claude-config/skills/agentchat\""
OUT="$(cd / && HOME="$H" PATH="$BASE_PATH" CLAUDE_CONFIG_DIR="$H/.claude/" LC_ALL="$LOC" bash "$R/scripts/install.sh" 2>&1)"
check "CLAUDE_CONFIG_DIR 就是 ~/.claude 時不警告" hasnt "CLAUDE_CONFIG_DIR"
}

echo "== 0. 靜態檢查：變數後面不能緊接非 ASCII 字元（UTF-8 locale 下 bash 3.2 會把它當成變數名稱的一部分）"
LOC=C
bad="$(LC_ALL=C grep -nE '[$][A-Za-z_][A-Za-z0-9_]*[^ -~]' "$SRC_SCRIPT" "${BASH_SOURCE[0]}" || true)"
check "install.sh 與 run.sh 沒有 \$var 緊接非 ASCII 的寫法" [ -z "$bad" ]
[ -z "$bad" ] || printf '%s\n' "$bad"

# 依序在 C 與可用的 UTF-8 locale 下跑全部情境。
locales="C"
for want in zh_TW.UTF-8 en_US.UTF-8; do
  found="$(locale -a 2>/dev/null | grep -i -x -m 1 "$(printf '%s' "$want" | sed 's/UTF-8/utf-\\{0,1\\}8/')" || true)"
  if [ -n "$found" ]; then
    locales="$locales $found"
  else
    echo "（系統沒有 ${want} locale，略過）"
  fi
done
for LOC in $locales; do
  echo "######## locale: ${LOC}"
  scenarios
done

echo
echo "通過 ${pass}，失敗 ${failn}"
[ "$failn" -eq 0 ]
