#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WATCH_SCRIPT="$ROOT_DIR/scripts/orca-scryer-watch.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

upstream_repo="$tmp_dir/upstream"
work_repo="$tmp_dir/work"
state_dir="$tmp_dir/state"
sync_log="$tmp_dir/sync.log"

git init -q "$upstream_repo"
git -C "$upstream_repo" config user.name "Test User"
git -C "$upstream_repo" config user.email "test@example.com"
git -C "$upstream_repo" checkout -q -b main
printf 'one\n' > "$upstream_repo/file.txt"
git -C "$upstream_repo" add file.txt
git -C "$upstream_repo" commit -q -m "initial"

git clone -q "$upstream_repo" "$work_repo"

sync_command="$tmp_dir/fake-sync.sh"
cat > "$sync_command" <<'SYNC'
#!/usr/bin/env bash
set -euo pipefail
printf 'sync:%s\n' "${ORCA_SCRYER_DETECTED_MAIN_SHA:-missing}" >> "$SYNC_LOG"
SYNC
chmod +x "$sync_command"

run_watch() {
  ORCA_SCRYER_REPO_DIR="$work_repo" \
    ORCA_SCRYER_STATE_DIR="$state_dir" \
    ORCA_SCRYER_SYNC_COMMAND="$sync_command" \
    SYNC_LOG="$sync_log" \
    "$WATCH_SCRIPT"
}

run_watch
test -f "$state_dir/origin-main.sha"
test ! -f "$sync_log"

run_watch
test ! -f "$sync_log"

printf 'two\n' >> "$upstream_repo/file.txt"
git -C "$upstream_repo" add file.txt
git -C "$upstream_repo" commit -q -m "upstream update"
expected_sha="$(git -C "$upstream_repo" rev-parse main)"

run_watch
grep -qx "sync:$expected_sha" "$sync_log"
grep -qx "$expected_sha" "$state_dir/origin-main.sha"
