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

export function getWslLoginShellOuterArgs(): ['sh', '-lc'] {
  return ['sh', '-lc']
}

export function buildWslLoginShellCommand(
  command: string,
  options: { isolateStartupStdio?: boolean } = {}
): string {
  const quotedCommand = quotePosixShell(
    options.isolateStartupStdio
      ? [
          'exec 0<&3',
          'exec 1>&4',
          'exec 2>&5',
          'exec 3<&-',
          'exec 4>&-',
          'exec 5>&-',
          command
        ].join('\n')
      : command
  )
  const startupIsolation = options.isolateStartupStdio
    ? ['exec 3<&0', 'exec 4>&1', 'exec 5>&2', 'exec </dev/null >/dev/null 2>/dev/null']
    : []
  return [
    ...startupIsolation,
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

export function buildWslInteractiveLoginShellCommand(): string {
  return [
    '_orca_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then',
    '  _orca_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then',
    '  _orca_wsl_shell=/bin/sh',
    'fi',
    '_orca_shell_ready_root=""',
    'if [ -n "${ORCA_USER_DATA_PATH:-}" ]; then',
    '  _orca_shell_ready_root="${ORCA_USER_DATA_PATH%/}/shell-ready"',
    'fi',
    '_orca_wsl_shell_name=$(basename "$_orca_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_orca_wsl_shell_name" in',
    '  bash)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -f "${_orca_shell_ready_root}/bash/rcfile" ]; then',
    '      exec "$_orca_wsl_shell" --rcfile "${_orca_shell_ready_root}/bash/rcfile"',
    '    fi',
    '    ;;',
    '  zsh)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -d "${_orca_shell_ready_root}/zsh" ]; then',
    '      export ZDOTDIR="${_orca_shell_ready_root}/zsh"',
    '    fi',
    '    ;;',
    'esac',
    'exec "$_orca_wsl_shell" -l'
  ].join('\n')
}
