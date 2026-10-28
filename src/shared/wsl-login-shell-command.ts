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
    '_orca_wsl_shell_wrapped=""',
    'case "$_orca_wsl_shell_name" in',
    '  bash)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -f "${_orca_shell_ready_root}/bash/rcfile" ]; then',
    '      exec "$_orca_wsl_shell" --rcfile "${_orca_shell_ready_root}/bash/rcfile"',
    '    fi',
    '    ;;',
    // Why: a WSL fish pane gets no shell-ready wrapper or XDG handoff, so this is its only `claude`.
    '  fish)',
    `    _orca_fish_init=${quotePosixShell(getFishClaudeShellFunction())}`,
    '    case ",${ORCA_SHELL_FEATURES:-}," in',
    '      *,ready,*)',
    `        _orca_fish_init=${quotePosixShell(`${WSL_FISH_SHELL_READY_INIT}\n${getFishClaudeShellFunction()}`)}`,
    '        ;;',
    '    esac',
    '    unset ORCA_SHELL_FEATURES',
    '    exec "$_orca_wsl_shell" -l -C "$_orca_fish_init"',
    '    ;;',
    '  zsh)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -d "${_orca_shell_ready_root}/zsh" ]; then',
    '      export ZDOTDIR="${_orca_shell_ready_root}/zsh"',
    '      _orca_wsl_shell_wrapped=1',
    '    fi',
    '    ;;',
    'esac',
    // Shells without a prompt hook can't report ready after their rc files; they wait out the cap.
    '[ -n "$_orca_wsl_shell_wrapped" ] || unset ORCA_SHELL_FEATURES',
    'exec "$_orca_wsl_shell" -l'
  ].join('\n')
}

// Keep identical to getFishShellReadyInitCommand(SHELL_READY_MARKER_ESCAPED) in shell-templates.ts.
export const WSL_FISH_SHELL_READY_INIT = [
  'function __orca_shell_ready_marker --on-event fish_prompt',
  '  builtin printf "\\033]777;orca-shell-ready\\007"',
  '  functions -e __orca_shell_ready_marker',
  'end'
].join('\n')
