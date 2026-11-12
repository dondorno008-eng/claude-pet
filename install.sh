#!/bin/bash
# Лошадка для Claude Code — установка одной командой (macOS):
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
# Удаление:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash -s -- --uninstall
#
# Что делает: кладёт HorsePet.app в ~/Applications и ставит мод horse-pet в Claude Code.
# curl, в отличие от браузера, не вешает на файл карантин macOS, поэтому приложение
# без подписи Apple запускается без «повреждено / нельзя открыть».
set -euo pipefail

REPO="${HORSE_PET_REPO:-dondorno008-eng/claude-pet}"
APP_NAME="HorsePet.app"
APP_DIR="$HOME/Applications"
MARKET="claude-pet"
PLUGIN="horse-pet"

say() { printf '🐴 %s\n' "$*"; }
die() { printf '🐴 Ошибка: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "лошадка пока живёт только на macOS"

# the claude CLI: on PATH, the native installer's place, or the copy inside the desktop app
find_claude() {
  if command -v claude >/dev/null 2>&1; then command -v claude; return; fi
  if [ -x "$HOME/.local/bin/claude" ]; then echo "$HOME/.local/bin/claude"; return; fi
  local c
  c=$(ls -1d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1 || true)
  [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  return 1
}

stop_app() {
  pkill -f "/$APP_NAME/Contents/MacOS/" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_app
  rm -rf "$APP_DIR/$APP_NAME"
  if CLAUDE=$(find_claude); then
    "$CLAUDE" plugin uninstall "$PLUGIN@$MARKET" >/dev/null 2>&1 || true
    "$CLAUDE" plugin marketplace remove "$MARKET" >/dev/null 2>&1 || true
  fi
  rm -rf "$HOME/.claude-pet"
  say "Лошадка удалена. Уже открытые окна Claude Code забудут её после перезапуска."
  exit 0
fi

CLAUDE=$(find_claude) || die "не нашёл Claude Code. Установите приложение Claude (вкладка Code) и запустите его хотя бы раз."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "Скачиваю лошадку…"
curl -fsSL "https://github.com/$REPO/releases/latest/download/HorsePet.zip" -o "$TMP/HorsePet.zip" \
  || die "не скачалось. Проверьте интернет и что релиз есть: https://github.com/$REPO/releases"

stop_app
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/$APP_NAME"
ditto -x -k "$TMP/HorsePet.zip" "$APP_DIR"
[ -d "$APP_DIR/$APP_NAME" ] || die "в архиве нет $APP_NAME"
# belt and braces: no quarantine flag, and a local ad-hoc signature so Apple Silicon runs it
xattr -dr com.apple.quarantine "$APP_DIR/$APP_NAME" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR/$APP_NAME" >/dev/null 2>&1 || true

say "Ставлю мод в Claude Code…"
"$CLAUDE" plugin marketplace add "$REPO" >/dev/null 2>&1 || "$CLAUDE" plugin marketplace update "$MARKET" >/dev/null 2>&1 || true
"$CLAUDE" plugin install "$PLUGIN@$MARKET" --scope user \
  || die "мод не поставился. Попробуйте ещё раз или напишите автору."

open -g "$APP_DIR/$APP_NAME"
say "Готово! Лошадка уже на экране."
say "Откройте новый чат в Claude Code (или перезапустите приложение Claude) — она начнёт следить за сессией."
say "Наведите на лошадку и нажмите ✎, чтобы написать Claude прямо оттуда."
