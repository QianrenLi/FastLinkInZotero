#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

NVM_BIN=${NVM_BIN:-nvm}

normalize_node_version() {
  version=$(printf '%s' "$1" | tr -d '\r' | sed 's/^[[:space:]]*//')
  version=${version%% *}

  case "$version" in
    v[0-9]*)
      printf '%s' "$version"
      ;;
    [0-9]*)
      printf 'v%s' "$version"
      ;;
    *)
      printf ''
      ;;
  esac
}

if ! command -v "$NVM_BIN" >/dev/null 2>&1; then
  echo "FastLink pipeline error: nvm is not available in PATH." >&2
  exit 1
fi

if [ -n "${FASTLINK_NODE_VERSION:-}" ]; then
  TARGET_NODE_VERSION=$FASTLINK_NODE_VERSION
elif [ -f "$REPO_ROOT/.nvmrc" ]; then
  TARGET_NODE_VERSION=$(tr -d '\r\n' < "$REPO_ROOT/.nvmrc")
else
  echo "FastLink pipeline error: set FASTLINK_NODE_VERSION or add .nvmrc." >&2
  exit 1
fi

TARGET_NODE_VERSION_NORMALIZED=$(normalize_node_version "$TARGET_NODE_VERSION")
if [ -z "$TARGET_NODE_VERSION_NORMALIZED" ]; then
  echo "FastLink pipeline error: invalid Node version '$TARGET_NODE_VERSION'." >&2
  exit 1
fi

ORIGINAL_NODE_VERSION=$(normalize_node_version "$("$NVM_BIN" current 2>/dev/null || true)")
case "$ORIGINAL_NODE_VERSION" in
  v[0-9]*)
    ;;
  *)
    ORIGINAL_NODE_VERSION=$(normalize_node_version "$(
      "$NVM_BIN" list 2>/dev/null | sed -n 's/^[[:space:]]*\*[[:space:]]*\([0-9][0-9.]*\).*/\1/p' | head -n 1
    )")
    ;;
esac

case "$ORIGINAL_NODE_VERSION" in
  v[0-9]*)
    ;;
  *)
    ORIGINAL_NODE_VERSION=$(normalize_node_version "$(node -v 2>/dev/null || true)")
    ;;
esac

restore_node() {
  status=$1

  if [ -n "${ORIGINAL_NODE_VERSION:-}" ] && \
    [ "$ORIGINAL_NODE_VERSION" != "$TARGET_NODE_VERSION_NORMALIZED" ]; then
    echo "==> Restoring Node $ORIGINAL_NODE_VERSION"
    "$NVM_BIN" use "$ORIGINAL_NODE_VERSION" >/dev/null
  fi

  exit "$status"
}

cleanup() {
  restore_node "$?"
}

trap cleanup EXIT HUP INT TERM

run_step() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run_named_step() {
  case "$1" in
    lint)
      run_step npm run lint:check
      ;;
    build)
      run_step npm run build
      ;;
    test)
      run_step npm test
      ;;
    typecheck)
      run_step npx tsc --noEmit
      ;;
    *)
      echo "FastLink pipeline error: unknown step '$1'." >&2
      echo "Supported steps: lint build test typecheck" >&2
      exit 1
      ;;
  esac
}

echo "==> Switching Node from ${ORIGINAL_NODE_VERSION:-unknown} to $TARGET_NODE_VERSION_NORMALIZED"
"$NVM_BIN" use "$TARGET_NODE_VERSION" >/dev/null

if command -v hash >/dev/null 2>&1; then
  hash -r 2>/dev/null || true
fi

run_step node -v
run_step npm -v

if [ "$#" -eq 0 ]; then
  set -- lint build test
fi

for step in "$@"; do
  run_named_step "$step"
done
