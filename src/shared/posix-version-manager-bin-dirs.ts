/**
 * Where a version manager puts binaries inside a POSIX guest.
 *
 * The guest-side twin of `detectCommandsInInstallDirs`, which the native
 * preflight branch already consults for the same reason -- "PATH may still be
 * unhydrated on a cold GUI launch". Without it, a WSL probe that cannot
 * establish the login PATH reports an nvm-installed claude/codex as not
 * installed, which is #9725.
 *
 * Kept in step with `getBaseVersionManagerDirectories` in
 * node-cli-command-resolution.ts and `getSystemCliInstallDirectories` in
 * system-cli-install-dirs.ts: a WSL user on asdf, mise, volta or fnm -- or on
 * Linuxbrew, snap or nix -- would otherwise still hit #9725 while the same user
 * on native does not. `/opt/homebrew` stays out because a WSL guest is Linux,
 * where Homebrew installs to the Linuxbrew prefix below.
 *
 * Version-manager dirs lead and the system block trails, which took the one
 * behavior change here: `/usr/local/bin` moved from before the nvm glob to
 * after it, so the guest ranks a version manager over a system install the way
 * native does. Bounded, not free: every entry is APPENDED behind a resolved
 * login PATH, so this can only re-rank a command that BOTH consumers would
 * otherwise miss, and both only test presence. Not full parity either -- the
 * glob expands lexicographically, while native orders nvm dirs
 * default-alias-first (#10932).
 *
 * Each entry is quoted so a `$HOME` containing a space cannot word-split into
 * a relative path -- except the nvm glob, where only the prefix is quoted so
 * the `*` still expands.
 */
const POSIX_VERSION_MANAGER_BIN_DIRS = [
  '"$HOME/.local/bin"',
  '"$HOME/.local/share/pnpm"',
  '"$HOME/.yarn/bin"',
  '"$HOME/.bun/bin"',
  '"$HOME/.volta/bin"',
  '"$HOME/.asdf/shims"',
  '"$HOME/.fnm/aliases/default/bin"',
  '"$HOME/.local/share/mise/shims"',
  '"$HOME"/.nvm/versions/node/*/bin',
  '"/usr/local/bin"',
  '"/snap/bin"',
  '"/home/linuxbrew/.linuxbrew/bin"',
  '"/nix/var/nix/profiles/default/bin"',
  '"$HOME/.nix-profile/bin"',
  // Why both: the opencode and Pi installers' own defaults, which no version manager owns (#829).
  '"$HOME/.opencode/bin"',
  '"$HOME/.vite-plus/bin"'
].join(' ')

/**
 * A prelude that APPENDS those directories to PATH.
 *
 * Append, never prepend: when the login PATH did resolve it is authoritative,
 * and a prepended fallback could shadow the binary the user actually runs with
 * an older one from a stale nvm version directory.
 */
export function buildPosixFallbackPathPrelude(): string {
  return [
    `for _orca_dir in ${POSIX_VERSION_MANAGER_BIN_DIRS}; do`,
    '  if [ -d "$_orca_dir" ]; then PATH="$PATH:$_orca_dir"; fi',
    'done',
    'export PATH',
    'unset _orca_dir'
  ].join('\n')
}
