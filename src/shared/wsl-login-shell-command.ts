import { ORCA_WSL_OPENCODE_MATERIALIZER_ENV } from './wsl-opencode-materializer-contract'

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

function buildFishOpenCodeMaterializerInitCommand(): string {
  const materializerBridge = [
    '. "$1" >/dev/null 2>&1',
    'if [ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ] && [ "${OPENCODE_CONFIG_DIR:-}" = "$ORCA_OPENCODE_CONFIG_DIR" ]; then',
    '  printf "%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0" "OPENCODE_CONFIG_DIR" "$OPENCODE_CONFIG_DIR" "ORCA_OPENCODE_CONFIG_DIR" "$ORCA_OPENCODE_CONFIG_DIR" "ORCA_OPENCODE_SOURCE_CONFIG_DIR" "${ORCA_OPENCODE_SOURCE_CONFIG_DIR:-}" "ORCA_AGENT_HOOK_ENDPOINT" "${ORCA_AGENT_HOOK_ENDPOINT:-}" "ORCA_MATERIALIZER_COMPLETE" "1"',
    'fi'
  ].join('\n')

  // Why: fish's init command runs after config.fish, so materializing through a
  // POSIX child here sees the user's final config without duplicating the script in fish syntax.
  return [
    `if test -n "$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"; and test -f "$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"`,
    '  set -l __orca_config ""',
    '  set -l __orca_overlay ""',
    '  set -l __orca_source ""',
    '  set -l __orca_endpoint ""',
    '  set -l __orca_materialized "0"',
    `  /bin/sh -c ${quotePosixShell(materializerBridge)} sh "$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}" | while read -z __orca_name; and read -z __orca_value`,
    '    switch "$__orca_name"',
    '      case OPENCODE_CONFIG_DIR',
    '        set __orca_config "$__orca_value"',
    '      case ORCA_OPENCODE_CONFIG_DIR',
    '        set __orca_overlay "$__orca_value"',
    '      case ORCA_OPENCODE_SOURCE_CONFIG_DIR',
    '        set __orca_source "$__orca_value"',
    '      case ORCA_AGENT_HOOK_ENDPOINT',
    '        set __orca_endpoint "$__orca_value"',
    '      case ORCA_MATERIALIZER_COMPLETE',
    '        set __orca_materialized "$__orca_value"',
    '    end',
    '  end',
    '  if test "$__orca_materialized" = "1"; and test -n "$__orca_config"; and test "$__orca_config" = "$__orca_overlay"',
    '    set -gx OPENCODE_CONFIG_DIR "$__orca_config"',
    '    set -gx ORCA_OPENCODE_CONFIG_DIR "$__orca_overlay"',
    '    if test -n "$__orca_source"',
    '      set -gx ORCA_OPENCODE_SOURCE_CONFIG_DIR "$__orca_source"',
    '    else',
    '      set -e ORCA_OPENCODE_SOURCE_CONFIG_DIR',
    '    end',
    '    if test -n "$__orca_endpoint"',
    '      set -gx ORCA_AGENT_HOOK_ENDPOINT "$__orca_endpoint"',
    '    end',
    '  end',
    'end'
  ].join('\n')
}

export function buildWslInteractiveLoginShellCommand(): string {
  const fishMaterializerInitCommand = quotePosixShell(buildFishOpenCodeMaterializerInitCommand())
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
    `    if [ -n "\${${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}:-}" ] && [ -f "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}" ]; then`,
    `      . "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"`,
    '    fi',
    '    ;;',
    '  zsh)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -f "${_orca_shell_ready_root}/zsh/.zlogin" ]; then',
    '      export ZDOTDIR="${_orca_shell_ready_root}/zsh"',
    `    elif [ -n "\${${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}:-}" ] && [ -f "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}" ]; then`,
    `      . "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"`,
    '    fi',
    '    ;;',
    '  fish)',
    '    # Why: --init-command runs after config.fish, so a guest config cannot',
    '    # replace the Orca plugin overlay before the first interactive command.',
    '    if "$_orca_wsl_shell" --help 2>&1 | grep -q -- "--init-command"; then',
    `      exec "$_orca_wsl_shell" -l --init-command ${fishMaterializerInitCommand}`,
    '    fi',
    '    # Why: unknown old fish builds must still launch if the post-config hook',
    '    # is unavailable; pre-login materialization is the safe degraded path.',
    `    if [ -n "\${${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}:-}" ] && [ -f "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}" ]; then`,
    `      . "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"`,
    '    fi',
    '    ;;',
    '  *)',
    '    # Why: ksh/mksh/dash/sh/ash only offer ENV, which .profile may replace;',
    '    # forcing a post-login wrapper could suppress user rc files. Degrade safely.',
    `    if [ -n "\${${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}:-}" ] && [ -f "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}" ]; then`,
    `      . "\$${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}"`,
    '    fi',
    '    ;;',
    'esac',
    'exec "$_orca_wsl_shell" -l'
  ].join('\n')
}
