import { getFishClaudeShellFunction } from './claude-shell-function'
import { buildPosixStdoutFence, type PosixStdoutFence } from './posix-stdout-fence'

export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Build `wsl.exe` argv that hands a POSIX script to the guest byte-for-byte.
 *
 * Why: `wsl.exe -d <distro> -- <argv>` expands `$name` in every argument against
 * the guest environment before the guest ever runs — it does this even when no
 * shell is in the command, so `-- /usr/bin/printf %s '$HOME'` prints /home/you.
 * That silently rewrites scripts (`awk '{print $2}'` loses its field ref) and no
 * amount of escaping on our side is reliable. `--exec` skips that preprocessing
 * and passes argv through untouched, so scripts mean what they say.
 */
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

/**
 * Run `command` through the distro login shell and fence its stdout.
 *
 * Why: the login shell has to be interactive for bash/zsh so PATH matches what
 * the user sees in their own terminal (nvm, mise and asdf all install into rc
 * files that only interactive shells read). But an interactive shell also runs
 * the distro's rc/motd, and stock Ubuntu writes its "run a command as
 * administrator" hint to *stdout*. The fence keeps the PATH benefit without the noise.
 */
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
    // Why the explicit root first: the wrapper tree is content-addressed, so its
    // path carries a hash the guest cannot derive. The host publishes the
    // resolved root and WSLENV /p-translates it. The ORCA_USER_DATA_PATH branch
    // stays as the fallback for an older host that exports only that.
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
    // Why no marker for the rest: without a prompt hook it could only come before
    // the shell's own startup files, which can still eat the command. They wait
    // out the host's timeout instead. Consumed so it never leaks into the shell.
    '[ -n "$_orca_wsl_shell_wrapped" ] || unset ORCA_SHELL_FEATURES',
    'exec "$_orca_wsl_shell" -l'
  ].join('\n')
}

/**
 * Guest fish reports ready from its first prompt, after config.fish.
 *
 * Why: fish has no wrapper dir, so the host holds a WSL startup command until
 * this fires (wsl-startup-shell-ready.ts, #24188). Must stay identical to
 * getFishShellReadyInitCommand(SHELL_READY_MARKER_ESCAPED) in src/main/shell-templates.ts.
 */
export const WSL_FISH_SHELL_READY_INIT = [
  'function __orca_shell_ready_marker --on-event fish_prompt',
  '  builtin printf "\\033]777;orca-shell-ready\\007"',
  '  functions -e __orca_shell_ready_marker',
  'end'
].join('\n')
