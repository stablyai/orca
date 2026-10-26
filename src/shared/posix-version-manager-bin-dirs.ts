/** Fallback guest CLI paths cover cold GUI login-PATH failures (#9725). Keep in step with native node-cli-command-resolution
 * and system-cli-install-dirs; WSL uses Linuxbrew, never /opt/homebrew. Rank version managers before system fallbacks,
 * but append all behind authoritative login PATH. Guest nvm glob is lexical, unlike native default-first (#10932).
 * Quote HOME prefixes to preserve spaces while leaving nvm’s glob expandable. */
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

/** Append behind login PATH so stale fallback nvm installs cannot shadow the user’s selected binary. */
export function buildPosixFallbackPathPrelude(): string {
  return [
    `for _orca_dir in ${POSIX_VERSION_MANAGER_BIN_DIRS}; do`,
    '  if [ -d "$_orca_dir" ]; then PATH="$PATH:$_orca_dir"; fi',
    'done',
    'export PATH',
    'unset _orca_dir'
  ].join('\n')
}
