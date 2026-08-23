/**
 * Where a version manager puts binaries inside a POSIX guest.
 *
 * This is the guest-side twin of `detectCommandsInInstallDirs`, which the
 * native preflight branch already consults for the same reason -- "PATH may
 * still be unhydrated on a cold GUI launch". Without it, a WSL probe that
 * cannot establish the login PATH reports an nvm-installed claude/codex as not
 * installed, which is #9725.
 *
 * Unquoted on purpose: the nvm entry is a glob the guest shell expands.
 */
export const POSIX_VERSION_MANAGER_BIN_DIRS = [
  '$HOME/.local/bin',
  '$HOME/.local/share/pnpm',
  '$HOME/.yarn/bin',
  '$HOME/.bun/bin',
  '/usr/local/bin',
  '$HOME/.nvm/versions/node/*/bin'
]

/**
 * A prelude that APPENDS those directories to PATH.
 *
 * Append, never prepend: when the login PATH did resolve it is authoritative,
 * and a prepended fallback could shadow the binary the user actually runs with
 * an older one from a stale nvm version directory.
 */
export function buildPosixFallbackPathPrelude(): string {
  return [
    `for _orca_dir in ${POSIX_VERSION_MANAGER_BIN_DIRS.join(' ')}; do`,
    '  if [ -d "$_orca_dir" ]; then PATH="$PATH:$_orca_dir"; fi',
    'done',
    'export PATH',
    'unset _orca_dir'
  ].join('\n')
}
