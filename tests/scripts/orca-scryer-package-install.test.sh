#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_SCRIPT="$ROOT_DIR/scripts/orca-scryer-package-install.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

repo_dir="$tmp_dir/repo"
release_dir="$tmp_dir/releases"
install_path="$tmp_dir/local/Orca.AppImage"
bin_dir="$tmp_dir/bin"
symlink_path="$bin_dir/orca"
desktop_launcher="$bin_dir/orca-app"
cli_launcher="$bin_dir/orca-app-cli"
appdir_root="$tmp_dir/Applications/Orca"
current_appdir="$appdir_root/current.AppDir"
appdir_name="orca-scryer-test.AppDir"
desktop_file="$tmp_dir/applications/orca-appimage.desktop"
build_log="$tmp_dir/build.log"

git init -q "$repo_dir"
git -C "$repo_dir" config user.name "Test User"
git -C "$repo_dir" config user.email "test@example.com"
git -C "$repo_dir" checkout -q -b orca-scryer
printf '{"name":"orca","version":"9.9.9-test"}\n' > "$repo_dir/package.json"
git -C "$repo_dir" add package.json
git -C "$repo_dir" commit -q -m "test package seed"
expected_commit="$(git -C "$repo_dir" rev-parse HEAD)"

fake_build="$tmp_dir/fake-build.sh"
cat > "$fake_build" <<'BUILD'
#!/usr/bin/env bash
set -euo pipefail
printf 'branch=%s\ncommit=%s\n' "$ORCA_SCRYER_RELEASE_BRANCH" "$ORCA_SCRYER_RELEASE_COMMIT" > "$BUILD_LOG"
mkdir -p "$ORCA_SCRYER_ARTIFACT_DIR"
cat > "$ORCA_SCRYER_ARTIFACT_DIR/orca-linux.AppImage" <<'APPIMAGE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--appimage-extract" ]]; then
  mkdir -p squashfs-root/resources/bin
  printf '#!/usr/bin/env bash\nprintf app-cli\n' > squashfs-root/resources/bin/orca
  printf '#!/usr/bin/env bash\nprintf app-gui\n' > squashfs-root/orca
  printf '#!/usr/bin/env bash\nprintf app-gui-ide\n' > squashfs-root/orca-ide
  printf 'fake-icon\n' > squashfs-root/orca-ide.png
  cat > squashfs-root/orca-ide.desktop <<'DESKTOP'
[Desktop Entry]
Name=Orca
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=orca-ide
StartupWMClass=Orca
X-AppImage-Version=9.9.9-test
Comment=Next-gen IDE for parallel agentic development
Categories=Utility;
DESKTOP
  chmod +x squashfs-root/orca squashfs-root/orca-ide
  exit 0
fi
printf 'appimage\n'
APPIMAGE
chmod +x "$ORCA_SCRYER_ARTIFACT_DIR/orca-linux.AppImage"
printf 'deb:%s\n' "$ORCA_SCRYER_RELEASE_COMMIT" > "$ORCA_SCRYER_ARTIFACT_DIR/orca-linux-amd64.deb"
BUILD
chmod +x "$fake_build"
mkdir -p "$(dirname "$desktop_file")"
printf '[Desktop Entry]\nName=Orca AppImage\nExec=/old/orca-app %%U\nType=Application\nIcon=/old/orca.png\nX-AppImage-Version=old-build\n' > "$desktop_file"

ORCA_SCRYER_REPO_DIR="$repo_dir" \
  ORCA_SCRYER_PACKAGE_COMMAND="$fake_build" \
  ORCA_SCRYER_ARTIFACT_DIR="$repo_dir/dist" \
  ORCA_SCRYER_RELEASE_DIR="$release_dir" \
  ORCA_SCRYER_AUTO_INSTALL=1 \
  ORCA_SCRYER_APPIMAGE_INSTALL_PATH="$install_path" \
  ORCA_SCRYER_APPIMAGE_SYMLINK="$symlink_path" \
  ORCA_SCRYER_APPIMAGE_DESKTOP_LAUNCHER="$desktop_launcher" \
  ORCA_SCRYER_APPIMAGE_CLI_LAUNCHER="$cli_launcher" \
  ORCA_SCRYER_APPDIR_ROOT="$appdir_root" \
  ORCA_SCRYER_CURRENT_APPDIR="$current_appdir" \
  ORCA_SCRYER_APPDIR_NAME="$appdir_name" \
  ORCA_SCRYER_APPIMAGE_DESKTOP_FILE="$desktop_file" \
  BUILD_LOG="$build_log" \
  "$PACKAGE_SCRIPT"

grep -qx 'branch=orca-scryer' "$build_log"
grep -qx "commit=$expected_commit" "$build_log"

release_manifest="$(find "$release_dir" -name manifest.env -print -quit)"
test -n "$release_manifest"
grep -qx "ORCA_SCRYER_RELEASE_BRANCH=orca-scryer" "$release_manifest"
grep -qx "ORCA_SCRYER_RELEASE_COMMIT=$expected_commit" "$release_manifest"

release_appimage="$(find "$release_dir" -name 'orca-linux.AppImage' -print -quit)"
test -f "$release_appimage"
test -x "$release_appimage"

test -x "$install_path"
test -L "$symlink_path"
test "$(readlink "$symlink_path")" = "$install_path"
test -L "$current_appdir"
test "$(readlink "$current_appdir")" = "$appdir_root/$appdir_name"
test -x "$current_appdir/orca"
test -x "$current_appdir/resources/bin/orca"
test -x "$desktop_launcher"
test -x "$cli_launcher"
grep -Fqx "APPDIR=\"$current_appdir\"" "$desktop_launcher"
grep -Fqx 'unset ELECTRON_RUN_AS_NODE' "$desktop_launcher"
grep -Fqx 'unset ORCA_TERMINAL_HANDLE ORCA_TAB_ID ORCA_PANE_KEY ORCA_WORKTREE_ID ORCA_APP_VERSION ORCA_SHELL_READY_MARKER' "$desktop_launcher"
grep -Fq 'exec "$APPDIR/orca-ide" --no-sandbox "$@"' "$desktop_launcher"
grep -Fq 'exec "$APPDIR/orca" --no-sandbox "$@"' "$desktop_launcher"
grep -Fqx "APPDIR=\"$current_appdir\"" "$cli_launcher"
grep -Fqx 'exec bash "$APPDIR/resources/bin/orca" "$@"' "$cli_launcher"
test "$("$cli_launcher")" = "app-cli"
grep -Fqx "Exec=$desktop_launcher %U" "$desktop_file"
grep -Fqx "Icon=$current_appdir/orca-ide.png" "$desktop_file"
grep -Fqx "X-AppImage-Version=9.9.9-test" "$desktop_file"

shim_repo="$tmp_dir/shim-repo"
shim_release_dir="$tmp_dir/shim-releases"
shim_bin="$tmp_dir/corepack-bin"
shim_log="$tmp_dir/corepack.log"

git init -q "$shim_repo"
git -C "$shim_repo" config user.name "Test User"
git -C "$shim_repo" config user.email "test@example.com"
git -C "$shim_repo" checkout -q -b orca-scryer
printf '{"name":"orca","version":"9.9.9-test"}\n' > "$shim_repo/package.json"
git -C "$shim_repo" add package.json
git -C "$shim_repo" commit -q -m "test corepack seed"
shim_commit="$(git -C "$shim_repo" rev-parse HEAD)"

mkdir -p "$shim_bin"
cat > "$shim_bin/corepack" <<'COREPACK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "pnpm" ]]; then
  echo "unexpected corepack command: $*" >&2
  exit 3
fi
shift
case "$*" in
  "run build:linux")
    pnpm run build
    ;;
  "run build")
    printf 'nested-pnpm-ok\n' > "$COREPACK_LOG"
    mkdir -p "$ORCA_SCRYER_ARTIFACT_DIR"
    printf 'appimage:%s\n' "$ORCA_SCRYER_RELEASE_COMMIT" > "$ORCA_SCRYER_ARTIFACT_DIR/orca-linux.AppImage"
    ;;
  *)
    echo "unexpected corepack pnpm command: $*" >&2
    exit 4
    ;;
esac
COREPACK
chmod +x "$shim_bin/corepack"

PATH="$shim_bin:/usr/bin:/bin" \
  ORCA_SCRYER_REPO_DIR="$shim_repo" \
  ORCA_SCRYER_ARTIFACT_DIR="$shim_repo/dist" \
  ORCA_SCRYER_RELEASE_DIR="$shim_release_dir" \
  COREPACK_LOG="$shim_log" \
  "$PACKAGE_SCRIPT"

grep -qx 'nested-pnpm-ok' "$shim_log"
shim_appimage="$(find "$shim_release_dir" -name 'orca-linux.AppImage' -print -quit)"
test -f "$shim_appimage"
grep -qx "appimage:$shim_commit" "$shim_appimage"
