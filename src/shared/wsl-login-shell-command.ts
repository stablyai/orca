import { getFishClaudeShellFunction } from './claude-shell-function'
import { buildPosixStdoutFence, type PosixStdoutFence } from './posix-stdout-fence'
import { quotePosixShell } from './shell-argument-quoting'

/** Use --exec to preserve guest argv. WSL’s -- expands $name even without a shell, corrupting scripts such as awk field references; host escaping cannot reliably prevent it. */
export function buildWslExecArgs(
  distro: string | undefined,
  shellArgs: readonly string[],
  options: { user?: string } = {}
): string[] {
  return [
    ...(distro ? ['-d', distro] : []),
    ...(options.user ? ['-u', options.user] : []),
    '--exec',
    ...shellArgs
  ]
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

export type WslCapturedLoginShellCommand = PosixStdoutFence

/** Use interactive bash/zsh login rc files for the user’s PATH, then fence stdout to exclude distro rc/motd chatter. */
export function buildWslCapturedLoginShellCommand(
  command: string,
  nonce?: string
): WslCapturedLoginShellCommand {
  const fence = buildPosixStdoutFence(command, 'WSL', nonce)
  return { ...fence, command: buildWslLoginShellCommand(fence.command) }
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
    // Use the host-published content-addressed wrapper root, /p-translated by WSLENV. Retain userData fallback for older hosts.
    'if [ -n "${ORCA_SHELL_READY_ROOT:-}" ]; then',
    '  _orca_shell_ready_root="${ORCA_SHELL_READY_ROOT%/}"',
    'elif [ -n "${ORCA_USER_DATA_PATH:-}" ]; then',
    '  _orca_shell_ready_root="${ORCA_USER_DATA_PATH%/}/shell-ready"',
    'fi',
    '_orca_wsl_shell_name=$(basename "$_orca_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_orca_wsl_shell_name" in',
    '  bash)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -f "${_orca_shell_ready_root}/bash/rcfile" ]; then',
    '      exec "$_orca_wsl_shell" --rcfile "${_orca_shell_ready_root}/bash/rcfile"',
    '    fi',
    '    ;;',
    // Why: a WSL fish pane gets no shell-ready wrapper or XDG handoff, so this is its only `claude`.
    '  fish)',
    `    exec "$_orca_wsl_shell" -l -C ${quotePosixShell(getFishClaudeShellFunction())}`,
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
