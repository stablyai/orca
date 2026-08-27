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
 * node-cli-command-resolution.ts: a WSL user on asdf, mise, volta or fnm would
 * otherwise still hit #9725 while the same user on native does not.
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
  '"/usr/local/bin"',
  '"$HOME"/.nvm/versions/node/*/bin'
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
