export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function escapeWslShCommandForWindows(command: string): string {
  // WSL preprocesses unescaped $ in Windows argv before the WSL-side shell
  // sees it, even when the POSIX script text would single-quote the dollar.
  let escaped = ''
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === '$' && command[index - 1] !== '\\') {
      escaped += '\\$'
      continue
    }
    escaped += char
  }
  return escaped
}

export function buildWslLoginShellCommand(command: string): string {
  const quotedCommand = quotePosixShell(command)
  return [
    '_orca_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then',
    '  _orca_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then',
    '  _orca_wsl_shell=/bin/sh',
    'fi',
    '_orca_wsl_shell_name=$(basename "$_orca_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_orca_wsl_shell_name" in',
    `  sh|dash) exec "$_orca_wsl_shell" -lc ${quotedCommand} ;;`,
    `  bash|zsh|ksh|mksh|ash) exec "$_orca_wsl_shell" -ilc ${quotedCommand} ;;`,
    `  *) exec /bin/sh -lc ${quotedCommand} ;;`,
    'esac'
  ].join('\n')
}

export function buildWslInteractiveLoginShellCommand(postLoginCommand?: string): string {
  const shellResolution = [
    '_orca_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then',
    '  _orca_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then',
    '  _orca_wsl_shell=/bin/sh',
    'fi'
  ]
  if (!postLoginCommand) {
    return [...shellResolution, 'exec "$_orca_wsl_shell" -l'].join('\n')
  }
  const quotedPostLoginCommand = quotePosixShell(postLoginCommand)
  const defaultInteractiveCommand = `${postLoginCommand}\nunset ENV\nexec "$ORCA_WSL_SHELL" -i`
  return [
    ...shellResolution,
    '_orca_wsl_shell_name=$(basename "$_orca_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_orca_wsl_shell_name" in',
    `  sh|dash) ORCA_WSL_SHELL="$_orca_wsl_shell" exec "$_orca_wsl_shell" -lc ${quotePosixShell(defaultInteractiveCommand)} ;;`,
    `  bash)
    # Why: install post-login wrappers in the same interactive shell so aliases,
    # functions, and prompt setup from the user's profile remain available.
    _orca_wsl_bootstrap_dir=$(mktemp -d "\${TMPDIR:-/tmp}/orca-wsl-shell.XXXXXX") || exit 1
    chmod 700 "$_orca_wsl_bootstrap_dir" || { rm -rf "$_orca_wsl_bootstrap_dir"; exit 1; }
    _orca_wsl_bash_rc="$_orca_wsl_bootstrap_dir/bashrc"
    {
      printf '%s\\n' '[[ -f /etc/profile ]] && source /etc/profile'
      printf '%s\\n' 'if [[ -f "$HOME/.bash_profile" ]]; then'
      printf '%s\\n' '  source "$HOME/.bash_profile"'
      printf '%s\\n' 'elif [[ -f "$HOME/.bash_login" ]]; then'
      printf '%s\\n' '  source "$HOME/.bash_login"'
      printf '%s\\n' 'elif [[ -f "$HOME/.profile" ]]; then'
      printf '%s\\n' '  source "$HOME/.profile"'
      printf '%s\\n' 'fi'
      printf '%s\\n' ${quotedPostLoginCommand}
      printf '%s\\n' 'rm -rf "\${ORCA_WSL_BOOTSTRAP_DIR:-}"'
      printf '%s\\n' 'unset ORCA_WSL_BOOTSTRAP_DIR'
    } > "$_orca_wsl_bash_rc" || { rm -rf "$_orca_wsl_bootstrap_dir"; exit 1; }
    ORCA_WSL_BOOTSTRAP_DIR="$_orca_wsl_bootstrap_dir" exec "$_orca_wsl_shell" --rcfile "$_orca_wsl_bash_rc" -i
    ;;`,
    `  zsh)
    # Why: use a temporary ZDOTDIR overlay so Orca can append setup after the
    # user's zsh startup files without launching a customization-free child shell.
    _orca_wsl_bootstrap_dir=$(mktemp -d "\${TMPDIR:-/tmp}/orca-wsl-shell.XXXXXX") || exit 1
    chmod 700 "$_orca_wsl_bootstrap_dir" || { rm -rf "$_orca_wsl_bootstrap_dir"; exit 1; }
_orca_wsl_orig_zdotdir="\${ZDOTDIR:-$HOME}"
cat > "$_orca_wsl_bootstrap_dir/.zshenv" <<'__ORCA_WSL_ZSHENV__'
_orca_wsl_zshenv_source_dir="\${ORCA_WSL_ORIG_ZDOTDIR:-$HOME}"
if [[ "\${_orca_wsl_zshenv_source_dir%/}" == "\${ORCA_WSL_BOOTSTRAP_DIR%/}" ]]; then
  _orca_wsl_zshenv_source_dir="$HOME"
fi
[[ -f "$_orca_wsl_zshenv_source_dir/.zshenv" ]] && source "$_orca_wsl_zshenv_source_dir/.zshenv"
export ORCA_WSL_USER_ZDOTDIR="\${ZDOTDIR:-$_orca_wsl_zshenv_source_dir}"
if [[ "\${ORCA_WSL_USER_ZDOTDIR%/}" == "\${ORCA_WSL_BOOTSTRAP_DIR%/}" ]]; then
  export ORCA_WSL_USER_ZDOTDIR="$_orca_wsl_zshenv_source_dir"
fi
export ZDOTDIR="\${ORCA_WSL_BOOTSTRAP_DIR}"
unset _orca_wsl_zshenv_source_dir
__ORCA_WSL_ZSHENV__
cat > "$_orca_wsl_bootstrap_dir/.zprofile" <<'__ORCA_WSL_ZPROFILE__'
[[ -f "$ORCA_WSL_USER_ZDOTDIR/.zprofile" ]] && source "$ORCA_WSL_USER_ZDOTDIR/.zprofile"
__ORCA_WSL_ZPROFILE__
cat > "$_orca_wsl_bootstrap_dir/.zshrc" <<'__ORCA_WSL_ZSHRC__'
[[ -f "$ORCA_WSL_USER_ZDOTDIR/.zshrc" ]] && source "$ORCA_WSL_USER_ZDOTDIR/.zshrc"
__ORCA_WSL_ZSHRC__
{
  printf '%s\\n' '[[ -f "$ORCA_WSL_USER_ZDOTDIR/.zlogin" ]] && source "$ORCA_WSL_USER_ZDOTDIR/.zlogin"'
  printf '%s\\n' ${quotedPostLoginCommand}
  printf '%s\\n' 'export ZDOTDIR="$ORCA_WSL_USER_ZDOTDIR"'
  printf '%s\\n' 'rm -rf "\${ORCA_WSL_BOOTSTRAP_DIR:-}"'
  printf '%s\\n' 'unset ORCA_WSL_BOOTSTRAP_DIR ORCA_WSL_ORIG_ZDOTDIR ORCA_WSL_USER_ZDOTDIR'
} > "$_orca_wsl_bootstrap_dir/.zlogin" || { rm -rf "$_orca_wsl_bootstrap_dir"; exit 1; }
    ORCA_WSL_BOOTSTRAP_DIR="$_orca_wsl_bootstrap_dir" ORCA_WSL_ORIG_ZDOTDIR="$_orca_wsl_orig_zdotdir" ZDOTDIR="$_orca_wsl_bootstrap_dir" exec "$_orca_wsl_shell" -l
    ;;`,
    `  ksh|mksh|ash) ORCA_WSL_SHELL="$_orca_wsl_shell" exec "$_orca_wsl_shell" -ilc ${quotePosixShell(defaultInteractiveCommand)} ;;`,
    `  *) ORCA_WSL_SHELL=/bin/sh exec /bin/sh -lc ${quotePosixShell(defaultInteractiveCommand)} ;;`,
    'esac'
  ].join('\n')
}
