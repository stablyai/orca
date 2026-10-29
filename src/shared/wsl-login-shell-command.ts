import { getFishClaudeShellFunction } from './claude-shell-function'
import { FISH_WSL_CWD_REPORT_FUNCTION } from './fish-wsl-cwd-report'
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

/** A bridge fish pane's `-C`: run after the user's config.fish, so it adds and never replaces. */
export function getWslFishInitCommand(): string {
  return `${getFishClaudeShellFunction()}\n${FISH_WSL_CWD_REPORT_FUNCTION}`
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
    // fish before 2.7 rejects -C and would fail the pane; it starts plain (no claude, no cwd hook).
    // fish 2.x prints --version to stderr, so both streams are read.
    '  fish)',
    '    _orca_fish_version=$("$_orca_wsl_shell" --version 2>&1)',
    '    case "${_orca_fish_version##*version }" in',
    '      [01].*|2.[0-6]|2.[0-6].*) ;;',
    `      *) exec "$_orca_wsl_shell" -l -C ${quotePosixShell(getWslFishInitCommand())} ;;`,
    '    esac',
    '    ;;',
    '  zsh)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -d "${_orca_shell_ready_root}/zsh" ]; then',
    '      export ZDOTDIR="${_orca_shell_ready_root}/zsh"',
    '    fi',
    '    ;;',
    // Why ENV: dash has no rcfile flag or prompt hook; an interactive sh reads $ENV after ~/.profile.
    // The shell expands ENV's value, so a root containing $, ` or \ is skipped, never mangled.
    '  sh|dash|ash)',
    '    if [ -n "${_orca_shell_ready_root:-}" ] && [ -f "${_orca_shell_ready_root}/sh/env" ]; then',
    '      case "$_orca_shell_ready_root" in',
    "        *'$'*|*'`'*|*'\\'*) ;;",
    '        *)',
    // If ~/.profile replaces ENV, nothing of ours runs after it to unset this; it then holds only the
    // user's own former ENV value.
    '          if [ -n "${ENV+x}" ]; then export ORCA_WSL_USER_ENV="$ENV"; fi',
    '          export ENV="${_orca_shell_ready_root}/sh/env"',
    '          ;;',
    '      esac',
    '    fi',
    '    ;;',
    'esac',
    'exec "$_orca_wsl_shell" -l'
  ].join('\n')
}
