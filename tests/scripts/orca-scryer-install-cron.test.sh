#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SCRIPT="$ROOT_DIR/scripts/orca-scryer-install-cron.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

repo_dir="$tmp_dir/repo"
cron_file="$tmp_dir/crontab"
fake_bin="$tmp_dir/bin"
install_path="$tmp_dir/local apps/Orca.AppImage"
symlink_path="$tmp_dir/bin apps/orca"
cli_launcher="$tmp_dir/bin apps/orca-app-cli"
package_command="printf package"

mkdir -p "$repo_dir/scripts" "$fake_bin"
printf '#!/usr/bin/env bash\n' > "$repo_dir/scripts/orca-scryer-watch.sh"
chmod +x "$repo_dir/scripts/orca-scryer-watch.sh"

cat > "$fake_bin/crontab" <<'CRONTAB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-l" ]]; then
  if [[ -f "$CRON_FILE" ]]; then
    cat "$CRON_FILE"
  else
    exit 1
  fi
else
  cat > "$CRON_FILE"
fi
CRONTAB
chmod +x "$fake_bin/crontab"

printf 'SHELL=/bin/bash\n' > "$cron_file"

PATH="$fake_bin:$PATH" \
  CRON_FILE="$cron_file" \
  ORCA_SCRYER_REPO_DIR="$repo_dir" \
  ORCA_SCRYER_STATE_DIR="$tmp_dir/state" \
  ORCA_SCRYER_LOG_DIR="$tmp_dir/logs" \
  ORCA_SCRYER_AUTO_PACKAGE=1 \
  ORCA_SCRYER_AUTO_INSTALL=1 \
  ORCA_SCRYER_INSTALL_KIND=appimage \
  ORCA_SCRYER_APPIMAGE_INSTALL_PATH="$install_path" \
  ORCA_SCRYER_APPIMAGE_SYMLINK="$symlink_path" \
  ORCA_SCRYER_APPIMAGE_CLI_LAUNCHER="$cli_launcher" \
  ORCA_SCRYER_PACKAGE_COMMAND="$package_command" \
  ORCA_SCRYER_ARTIFACT_DIR="$tmp_dir/artifacts" \
  ORCA_SCRYER_RELEASE_DIR="$tmp_dir/releases" \
  "$INSTALL_SCRIPT" >/dev/null

cron_line="$(awk '/# BEGIN orca-scryer-watch/{getline; print; exit}' "$cron_file")"
test -n "$cron_line"

printf -v escaped_repo '%q' "$repo_dir"
printf -v escaped_watch '%q' "$repo_dir/scripts/orca-scryer-watch.sh"
printf -v escaped_log '%q' "$tmp_dir/logs/watch-cron.log"
printf -v escaped_install '%q' "$install_path"
printf -v escaped_symlink '%q' "$symlink_path"
printf -v escaped_cli '%q' "$cli_launcher"
printf -v escaped_package '%q' "$package_command"
printf -v escaped_artifact '%q' "$tmp_dir/artifacts"
printf -v escaped_release '%q' "$tmp_dir/releases"

grep -qx 'SHELL=/bin/bash' "$cron_file"
grep -qx '# BEGIN orca-scryer-watch' "$cron_file"
grep -qx '# END orca-scryer-watch' "$cron_file"
[[ "$cron_line" == *"ORCA_SCRYER_REPO_DIR=$escaped_repo"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_AUTO_PACKAGE=1"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_AUTO_INSTALL=1"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_INSTALL_KIND=appimage"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_APPIMAGE_INSTALL_PATH=$escaped_install"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_APPIMAGE_SYMLINK=$escaped_symlink"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_APPIMAGE_CLI_LAUNCHER=$escaped_cli"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_PACKAGE_COMMAND=$escaped_package"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_ARTIFACT_DIR=$escaped_artifact"* ]]
[[ "$cron_line" == *"ORCA_SCRYER_RELEASE_DIR=$escaped_release"* ]]
[[ "$cron_line" == *"$escaped_watch >> $escaped_log 2>&1"* ]]
