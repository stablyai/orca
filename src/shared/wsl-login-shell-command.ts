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
  shellArgs: readonly string[]
): string[] {
  return [...(distro ? ['-d', distro] : []), '--exec', ...shellArgs]
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

export type WslCapturedLoginShellCommand = {
  command: string
  /** Payload the command wrote, or null when the fence never appeared. */
  readStdout: (stdout: string) => string | null
  // Why exposed: binary reads (`git show` blob content) must slice bytes rather
  // than decode to a string first, and this module is bundled for the renderer,
  // so it cannot reference Buffer itself.
  beginMarker: string
  endMarker: string
}

// Why: the fence has to be absent from both the rc output ahead of it and the
// payload behind it. A per-call nonce is the only spelling that guarantees
// both -- `cat`-ing a file that happens to quote a fixed marker would otherwise
// truncate the file. Not security-sensitive, so Math.random is sufficient.
function nextWslCaptureNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Run `command` through the distro login shell and fence its stdout.
 *
 * Why: the login shell has to be interactive for bash/zsh so PATH matches what
 * the user sees in their own terminal (nvm, mise and asdf all install into rc
 * files that only interactive shells read). But an interactive shell also runs
 * the distro's rc/motd, and stock Ubuntu writes its "run a command as
 * administrator" hint to *stdout*. Anything parsing that stream reads the
 * banner as data. The fence marks where the payload starts and ends so callers
 * keep the PATH benefit without the noise.
 */
export function buildWslCapturedLoginShellCommand(
  command: string,
  nonce: string = nextWslCaptureNonce()
): WslCapturedLoginShellCommand {
  const begin = `__ORCA_WSL_CAPTURE_BEGIN_${nonce}__`
  const end = `__ORCA_WSL_CAPTURE_END_${nonce}__`
  return {
    beginMarker: begin,
    endMarker: end,
    command: buildWslLoginShellCommand(
      [
        `printf %s ${quotePosixShell(begin)}`,
        command,
        '_orca_capture_status=$?',
        `printf %s ${quotePosixShell(end)}`,
        'exit $_orca_capture_status'
      ].join('\n')
    ),
    readStdout: (stdout) => {
      // Why lastIndexOf: a login shell can echo the command text before running
      // it (`set -x` in an rc file), which repeats the opening fence verbatim.
      // The real payload always follows the last one. The nonce keeps a payload
      // that happens to quote a marker from colliding.
      const beginIndex = stdout.lastIndexOf(begin)
      if (beginIndex === -1) {
        return null
      }
      const payloadStart = beginIndex + begin.length
      const endIndex = stdout.indexOf(end, payloadStart)
      // A payload that exited early never prints the closing fence; the rest of
      // the stream is still its output, and login shells run exit hooks after it.
      return endIndex === -1 ? stdout.slice(payloadStart) : stdout.slice(payloadStart, endIndex)
    }
  }
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
