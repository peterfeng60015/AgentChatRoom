#!/usr/bin/env bash
# agentchat 本機安裝腳本：建立 agentchat 指令，以及 Claude Code、Codex CLI、Gemini CLI 的 /agentchat skill 與指令的 symlink。
#
# 用法：bash scripts/install.sh [--dry-run] [--uninstall]
#
#   （不帶選項）  安裝或更新。可以重複執行。
#   --dry-run     只印出會做什麼，不改任何檔案。
#   --uninstall   移除本 repo 建立的 symlink（只刪指向這個 repo 的）。
#
# 這個腳本不建立也不修改 .env，也不碰本機狀態目錄（~/.agentchat）。
#
# 寫法上的限制：
# - macOS 內建的是 bash 3.2，所以不用陣列、關聯陣列等 bash 4 才有的寫法。
# - 變數後面緊接非 ASCII 字元（全形標點、中文）時一律寫成 ${var}：bash 3.2 在 UTF-8 locale 下
#   會把多位元組字元的第一個位元組當成變數名稱的一部分，配合 set -u 會直接中止。
set -Eeuo pipefail

# 預檢已經擋掉常見的失敗，但仍可能有抓不到的（例如 ACL 禁止刪除舊連結、檢查後權限才被改）。
# 中途失敗時說清楚：前面印出的步驟都已完成，修好後重跑即可。-E 讓函式裡的失敗也會觸發這個 trap。
trap 'printf "[FAIL] %s\n" "上一步失敗，已中止。前面印出的步驟都已完成；修正問題後重跑即可（可以重複執行）。" >&2' ERR

# 設了 CDPATH 時 cd 會把路徑印到 stdout，混進下面 $(...) 的結果。
unset CDPATH

usage() {
  cat <<'EOF'
用法：bash scripts/install.sh [--dry-run] [--uninstall]

  （不帶選項）  安裝或更新 agentchat 指令與各家 CLI 的 skill、指令的 symlink，可重複執行
  --dry-run     只印出會做什麼，不改任何檔案
  --uninstall   移除本 repo 建立的 symlink
  -h, --help    顯示這段說明
EOF
}

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "install.sh: 不認得的選項：${arg}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 2; }

# ---------- 環境檢查 ----------

case "${HOME:-}" in
  '') die "HOME 沒有設定，無法決定安裝位置" ;;
  /*) ;;
  *) die "HOME 必須是絕對路徑（目前是「${HOME}」）" ;;
esac
# 去掉結尾的 /（可能不只一個），PATH 比對與印出的路徑才不會出現 //。HOME=/ 時變成空字串，下面的路徑仍然正確。
HOME_DIR="$HOME"
while case "$HOME_DIR" in */) true ;; *) false ;; esac; do
  HOME_DIR="${HOME_DIR%/}"
done
# HOME 不存在時照樣安裝（容器裡建帳號沒建家目錄是合法情況，Claude Code 也會在同一個 HOME 底下建 .claude），
# 但提醒一聲，萬一是 HOME 打錯了看得出來。HOME 存在但不是目錄就無法繼續。
if [ -e "${HOME_DIR:-/}" ] && [ ! -d "${HOME_DIR:-/}" ]; then
  die "HOME（${HOME}）不是目錄"
fi
if [ ! -e "${HOME_DIR:-/}" ]; then
  warn "HOME（${HOME}）不存在，安裝時會把需要的目錄一路建出來。如果 HOME 設錯了，請先修正再執行。"
fi

# 用 sudo 執行而保留了使用者的 HOME 時，會在使用者家目錄建出 root 擁有的目錄，之後一般身分就改不動了。
# 容器裡以 root 執行、HOME 也屬於 root 是正常情況，不擋。
if [ "$(id -u)" = 0 ] && [ -e "${HOME_DIR:-/}" ]; then
  home_owner="$(ls -nd "${HOME_DIR:-/}" | awk '{print $3}')"
  if [ "$home_owner" != 0 ]; then
    die "正以 root 執行，但 HOME（${HOME}）屬於其他使用者，大概是用了 sudo。請用自己的帳號直接執行，不要加 sudo。"
  fi
fi

# 找出腳本檔的實體位置。不支援從 stdin 或管線執行：那樣無從得知 repo 在哪裡。
script_path="${BASH_SOURCE[0]:-}"
if [ -z "$script_path" ] || [ ! -f "$script_path" ]; then
  die "請在 repo 根目錄用 bash scripts/install.sh 執行（不支援從 stdin 或管線執行）"
fi
# 腳本檔本身可能是 symlink；macOS 舊版 readlink 沒有 -f，自己一路解析，次數設上限以防連結迴圈。
hops=0
while [ -L "$script_path" ]; do
  hops=$((hops + 1))
  [ "$hops" -le 40 ] || die "解析腳本位置時遇到連結迴圈：${script_path}"
  link_target="$(readlink "$script_path")"
  case "$link_target" in
    /*) script_path="$link_target" ;;
    *) script_path="$(dirname "$script_path")/$link_target" ;;
  esac
done

# 實體路徑：symlink 要指向 repo 的真正位置，透過別名路徑執行時才不會建出不同的連結，解除安裝時的比對也才一致。
# bash 內建的 pwd 會保留使用者打的大小寫，在不分大小寫的檔案系統上會記下錯的大小寫，所以優先用 /bin/pwd -P。
physical_pwd() {
  if [ -x /bin/pwd ]; then
    /bin/pwd -P
  else
    pwd -P
  fi
}
SCRIPT_DIR="$(cd -P "$(dirname "$script_path")" && physical_pwd)"
REPO_DIR="$(cd -P "$SCRIPT_DIR/.." && physical_pwd)"

BIN_SRC="$REPO_DIR/bin/agentchat.js"
SKILL_SRC="$REPO_DIR/skills/claude-code/agentchat"
BIN_DIR="$HOME_DIR/.local/bin"
BIN_DST="$BIN_DIR/agentchat"
SKILL_PARENT="$HOME_DIR/.claude/skills"
SKILL_DST="$SKILL_PARENT/agentchat"
# Codex CLI 與 Gemini CLI 共用的 skill：兩家都讀 ~/.agents/skills/（Gemini CLI 把它當 ~/.gemini/skills/ 的別名，而且優先）。
AGENTS_SKILL_SRC="$REPO_DIR/skills/agents/agentchat"
AGENTS_SKILL_DST="$HOME_DIR/.agents/skills/agentchat"
# Gemini CLI 的 /agentchat 自訂指令。
GEMINI_CMD_SRC="$REPO_DIR/skills/gemini-cli/agentchat.toml"
GEMINI_CMD_DST="$HOME_DIR/.gemini/commands/agentchat.toml"
STATE_DIR_LABEL="${AGENTCHAT_STATE_DIR:-~/.agentchat}"

# ---------- 共用函式 ----------

# 動作：dry-run 時只印「將…」；否則先執行再印，失敗會因 set -e 中止，不會印出沒做成的事。
step() {
  local label="$1" msg="$2"
  shift 2
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[將%s] %s\n' "$label" "$msg"
  else
    "$@"
    printf '[%s] %s\n' "$label" "$msg"
  fi
}

# 0：dst 是指向 src 的 symlink。字串相同，或實際指到同一個檔案或目錄（-ef 比對 inode，
# 連結鏈、相對路徑連結、大小寫不同的路徑都認得）。
points_to() {
  local dst="$1" src="$2"
  [ -L "$dst" ] || return 1
  [ "$(readlink "$dst")" = "$src" ] && return 0
  [ -e "$src" ] && [ "$dst" -ef "$src" ]
}

# 0：兩個路徑是同一個目錄。目錄還不存在時只能比字串。
# 相對路徑（例如 PATH 裡的 .）會依目前目錄解讀，不拿來比 inode，以免在 ~/.local/bin 裡執行時誤判。
same_dir() {
  [ "$1" = "$2" ] && return 0
  [ "$1" = "$2/" ] && return 0
  case "$1" in
    /*) [ -d "$1" ] && [ -d "$2" ] && [ "$1" -ef "$2" ] ;;
    *) return 1 ;;
  esac
}

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run 模式：只列出會做的事，不改任何檔案。"
fi
say "repo：${REPO_DIR}"

# git worktree 的 .git 是一個檔案，內容是 gitdir: <主 repo>/.git/worktrees/<名稱>；submodule 也是檔案但指向 modules/，不算。
if [ -f "$REPO_DIR/.git" ]; then
  case "$(head -n 1 "$REPO_DIR/.git" 2>/dev/null || true)" in
    gitdir:*/worktrees/*)
      warn "這是 git worktree。連結會指向這裡，worktree 被移除後 agentchat 與 skill 就會失效；長期使用請在主 checkout 執行 install.sh。"
      ;;
  esac
fi

# ---------- 解除安裝 ----------

# 先判斷每個連結要不要刪、刪不刪得掉，全部確認後才動手，避免只刪一半。
UNINSTALL_ERRORS=0
check_uninstall() {
  local dst="$1" src="$2"
  if points_to "$dst" "$src" && [ ! -w "$(dirname "$dst")" ]; then
    fail "沒有權限刪除 ${dst}（所在目錄不可寫）。"
    UNINSTALL_ERRORS=$((UNINSTALL_ERRORS + 1))
  fi
}

uninstall_link() {
  local dst="$1" src="$2"
  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
    say "[略過] ${dst} 不存在"
  elif points_to "$dst" "$src"; then
    step 移除 "$dst" rm "$dst"
  elif [ -L "$dst" ] && [ ! -e "$dst" ]; then
    say "[略過] ${dst} 指向 $(readlink "$dst")，但目標不存在或無法解析，無法確認是不是這個 repo 建的，不刪。請自行檢查。"
  elif [ -L "$dst" ]; then
    say "[略過] ${dst} 指向 $(readlink "$dst")，不是這個 repo 建的，不刪"
  else
    say "[略過] ${dst} 不是 symlink，不是這個腳本建的，不刪"
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  check_uninstall "$BIN_DST" "$BIN_SRC"
  check_uninstall "$SKILL_DST" "$SKILL_SRC"
  check_uninstall "$AGENTS_SKILL_DST" "$AGENTS_SKILL_SRC"
  check_uninstall "$GEMINI_CMD_DST" "$GEMINI_CMD_SRC"
  if [ "$UNINSTALL_ERRORS" -gt 0 ]; then
    fail "有 ${UNINSTALL_ERRORS} 個問題，沒有做任何變更。"
    exit 1
  fi
  uninstall_link "$BIN_DST" "$BIN_SRC"
  uninstall_link "$SKILL_DST" "$SKILL_SRC"
  uninstall_link "$AGENTS_SKILL_DST" "$AGENTS_SKILL_SRC"
  uninstall_link "$GEMINI_CMD_DST" "$GEMINI_CMD_SRC"
  say ""
  say "沒有動到：${REPO_DIR}/.env（如果有）與本機狀態目錄 ${STATE_DIR_LABEL}（含 webhook 快取）。不再需要時請自行刪除。"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry-run 結束，沒有改任何檔案。"
  fi
  exit 0
fi

# ---------- 安裝前檢查：全部通過才動手，避免只裝了一半 ----------

errors=0

if ! command -v node >/dev/null 2>&1; then
  fail "找不到 node。agentchat 需要 Node.js 18.17 以上，請先安裝（https://nodejs.org/）。"
  errors=$((errors + 1))
else
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  node_major="${node_version%%.*}"
  node_rest="${node_version#*.}"
  node_minor="${node_rest%%.*}"
  case "$node_major$node_minor" in
    ''|*[!0-9]*)
      fail "無法判斷 Node 版本（node -p 回傳「${node_version}」）。"
      errors=$((errors + 1))
      ;;
    *)
      if [ "$node_major" -gt 18 ] || { [ "$node_major" -eq 18 ] && [ "$node_minor" -ge 17 ]; }; then
        say "[OK] Node ${node_version}"
      else
        fail "Node ${node_version} 太舊，agentchat 需要 18.17 以上。"
        errors=$((errors + 1))
      fi
      ;;
  esac
fi

if [ ! -f "$BIN_SRC" ]; then
  fail "找不到 ${BIN_SRC}，確認 repo 是完整的 clone。"
  errors=$((errors + 1))
fi
for required in "$SKILL_SRC/SKILL.md" "$AGENTS_SKILL_SRC/SKILL.md" "$GEMINI_CMD_SRC"; do
  if [ ! -f "$required" ]; then
    fail "找不到 ${required}，確認 repo 是完整的 clone。"
    errors=$((errors + 1))
  fi
done

# 目標若已存在且不是 symlink，可能是使用者自己的檔案或另一份安裝，不覆蓋。
# 需要建立或取代連結時，所在目錄（還不存在就往上找第一個已存在的祖先）必須是可寫的目錄。
check_target() {
  local dst="$1" src="$2" dir
  if points_to "$dst" "$src"; then
    return 0
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    if [ -d "$dst" ]; then
      fail "${dst} 已存在而且是一般目錄（不是 symlink），不覆蓋。確認裡面的東西不需要後，自行移走或改名再重跑。"
    else
      fail "${dst} 已存在而且是一般檔案（不是 symlink），不覆蓋。確認它不需要後，自行移走或改名再重跑。"
    fi
    errors=$((errors + 1))
    return 0
  fi
  dir="$(dirname "$dst")"
  while [ ! -e "$dir" ] && [ ! -L "$dir" ]; do
    dir="$(dirname "$dir")"
  done
  if [ -L "$dir" ] && [ ! -e "$dir" ]; then
    fail "${dir} 是斷掉的 symlink（指向 $(readlink "$dir")），無法在它底下建立連結。請修好或移走它。"
    errors=$((errors + 1))
  elif [ ! -d "$dir" ]; then
    fail "${dir} 已存在但不是目錄，無法在它底下建立連結。請先移走它。"
    errors=$((errors + 1))
  elif [ ! -w "$dir" ]; then
    fail "沒有權限寫入 ${dir}，無法建立 ${dst}。請檢查這個目錄的擁有者與權限（常見原因是曾用 sudo 執行過相關工具）。"
    errors=$((errors + 1))
  fi
}
check_target "$BIN_DST" "$BIN_SRC"
check_target "$SKILL_DST" "$SKILL_SRC"
check_target "$AGENTS_SKILL_DST" "$AGENTS_SKILL_SRC"
check_target "$GEMINI_CMD_DST" "$GEMINI_CMD_SRC"

if [ "$errors" -gt 0 ]; then
  fail "有 ${errors} 個問題，沒有做任何變更。"
  exit 1
fi

# ---------- 安裝 ----------

# chmod 是第一個會改東西的動作，失敗時什麼都還沒改，直接說明後結束。
if [ -x "$BIN_SRC" ]; then
  say "[OK] ${BIN_SRC} 已可執行"
elif [ "$DRY_RUN" -eq 1 ]; then
  say "[將設定] chmod +x ${BIN_SRC}"
elif chmod +x "$BIN_SRC"; then
  say "[設定] chmod +x ${BIN_SRC}"
else
  fail "無法把 ${BIN_SRC} 設成可執行（擁有者、檔案旗標或唯讀檔案系統）。沒有做其他變更；處理後重跑，或重新 clone。"
  exit 1
fi

# expected_suffix 用來判斷被取代的舊連結像不像本工具建的（例如另一份 clone）；不像就提醒使用者。
install_link() {
  local src="$1" dst="$2" expected_suffix="$3" parent old label msg
  parent="$(dirname "$dst")"
  if points_to "$dst" "$src"; then
    say "[OK] ${dst} 已指向本 repo，不變"
    return 0
  fi
  label=連結
  msg="${dst} -> ${src}"
  if [ -L "$dst" ]; then
    old="$(readlink "$dst")"
    case "$old" in
      *"$expected_suffix"|*"$expected_suffix/") ;;
      *) warn "${dst} 原本指向 ${old}，看起來不是 agentchat 的連結。若那是別的工具需要的，請自行改回。" ;;
    esac
    label=取代
    msg="${msg}（原本指向 ${old}）"
  fi
  if [ ! -d "$parent" ]; then
    step 建立目錄 "$parent" mkdir -p "$parent"
  fi
  step "$label" "$msg" ln -sfn "$src" "$dst"
}

install_link "$BIN_SRC" "$BIN_DST" "/bin/agentchat.js"
install_link "$SKILL_SRC" "$SKILL_DST" "/skills/claude-code/agentchat"
install_link "$AGENTS_SKILL_SRC" "$AGENTS_SKILL_DST" "/skills/agents/agentchat"
install_link "$GEMINI_CMD_SRC" "$GEMINI_CMD_DST" "/skills/gemini-cli/agentchat.toml"

# Claude Code 的設定目錄可以用 CLAUDE_CONFIG_DIR 改到別處，那時它不會讀 ~/.claude/skills。
if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && ! same_dir "${CLAUDE_CONFIG_DIR%/}" "$HOME_DIR/.claude"; then
  warn "你設了 CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}，Claude Code 會從那裡的 skills/ 讀 skill，不會讀 ~/.claude/skills。"
  warn "要用 /agentchat 的話，另外建立連結：ln -sfn \"${SKILL_SRC}\" \"${CLAUDE_CONFIG_DIR%/}/skills/agentchat\""
fi

# ---------- PATH ----------

# 逐項比對 PATH：~/.local/bin 在不在、它前面有沒有別的 agentchat 會先被找到。
# 關掉 glob，PATH 項目裡的 * ? [ 才不會被展開。
in_path=0
shadow=""
set -f
old_ifs="$IFS"
IFS=:
for p in $PATH; do
  [ -n "$p" ] || continue
  if same_dir "$p" "$BIN_DIR"; then
    in_path=1
    break
  fi
  if [ -z "$shadow" ] && [ -f "$p/agentchat" ] && [ -x "$p/agentchat" ] && ! [ "$p/agentchat" -ef "$BIN_SRC" ]; then
    shadow="$p/agentchat"
  fi
done
IFS="$old_ifs"
set +f

if [ "$in_path" -eq 0 ]; then
  case "${SHELL:-}" in
    */zsh) rc_file="~/.zshrc" ;;
    */bash) rc_file="~/.bashrc（macOS 的登入 shell 讀 ~/.bash_profile）" ;;
    *) rc_file="你的 shell 設定檔" ;;
  esac
  if [ -n "$shadow" ]; then
    warn "${BIN_DIR} 不在 PATH 裡，現在打 agentchat 會執行到 ${shadow}，不是這個 repo。"
  else
    warn "${BIN_DIR} 不在 PATH 裡，直接打 agentchat 會找不到指令。"
  fi
  warn "修正：把下面這行加到 ${rc_file}，再開一個新的終端機："
  warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  warn "已經開著的 Claude Code、Gemini CLI、Codex CLI 要重新啟動才會拿到新的 PATH。"
elif [ -n "$shadow" ]; then
  warn "PATH 裡排在 ${BIN_DIR} 前面的 ${shadow} 會先被找到，打 agentchat 執行的不是這個 repo。請調整 PATH 順序或移除舊的那個。"
fi

# ---------- 下一步 ----------

say ""
if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run 結束，沒有改任何檔案。拿掉 --dry-run 再執行一次即可安裝。"
  exit 0
fi

say "安裝完成。下一步："
if [ -f "$REPO_DIR/.env" ]; then
  say "  1. 確認 ${REPO_DIR}/.env 裡的 DISCORD_BOT_TOKEN 已填好（本腳本不會改 .env）。"
else
  say "  1. 複製設定檔並填入 bot token（.env 不進 git）："
  say "       cp \"${REPO_DIR}/.env.example\" \"${REPO_DIR}/.env\""
  say "     然後編輯 .env，填 DISCORD_BOT_TOKEN。"
fi
say "  2. 確認 ${REPO_DIR}/config/room.json 的 guildId、channelId、moderatorUserId 是你的伺服器、頻道與 Discord 使用者 ID。"
if [ "$in_path" -eq 1 ]; then
  say "  3. 執行 agentchat doctor 檢查設定與 Discord 連線。"
else
  say "  3. 照上面的提示把 ~/.local/bin 加進 PATH，開新的終端機後執行 agentchat doctor 檢查設定與 Discord 連線。"
fi
