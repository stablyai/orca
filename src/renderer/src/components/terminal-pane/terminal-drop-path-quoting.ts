import { quoteStartupArg, type AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'

const POSIX_BARE_PATH_RE = /^[a-zA-Z0-9_./@:-]+$/
const WINDOWS_BARE_PATH_RE = /^[a-zA-Z0-9_./@:\\-]+$/
// Live inside double quotes in PowerShell (`$`, backtick, typographic double
// quotes), cmd (`%`, `!` under delayed expansion) or Git Bash (`$`, backtick, `!`).
const WINDOWS_DOUBLE_QUOTE_LIVE_RE = /["$`%!\u201C\u201D\u201E]/
const CMD_QUOTE_BREAKS = new Map([
  ['%', '"^%"'],
  ['"', '""']
])

/**
 * True for C0 controls and DEL. A terminal reads these as editing keys, not
 * path text: C-u clears an open quote and LF submits the line, so no quoting
 * can make such a path safe to type.
 */
export function hasTerminalDropControlByte(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

/**
 * True when `"path"` reads literally in PowerShell, cmd and Git Bash alike. A
 * trailing backslash is excluded because CommandLineToArgvW reads `\"` as a
 * literal quote.
 */
export function isWindowsDoubleQuoteLiteralPath(path: string): boolean {
  return (
    !WINDOWS_DOUBLE_QUOTE_LIVE_RE.test(path) &&
    !path.endsWith('\\') &&
    !hasTerminalDropControlByte(path)
  )
}

/**
 * Quotes a dropped path as one literal argument for the shell reading the pane.
 * The shell is the *target's*, not the client OS's: a Windows client dropping
 * onto a Linux SSH worktree must still produce POSIX quoting. Callers must
 * refuse control bytes first (see hasTerminalDropControlByte).
 */
export function quoteTerminalDropPath(path: string, shell: AgentStartupShell): string {
  if (shell === 'posix') {
    return POSIX_BARE_PATH_RE.test(path) ? path : quoteStartupArg(path, 'posix')
  }
  if (WINDOWS_BARE_PATH_RE.test(path)) {
    return path
  }
  // Why prefer plain double quotes: a remote pane's shell is a best guess, and
  // this form stays literal even when PowerShell and cmd are mixed up.
  if (isWindowsDoubleQuoteLiteralPath(path)) {
    return `"${path}"`
  }
  return shell === 'cmd' ? quoteCmdPath(path) : quoteStartupArg(path, 'powershell')
}

/**
 * Why not quoteStartupArg's cmd form: cmd keeps `^` literal inside double
 * quotes, so its caret escapes would land in the path. Quotes alone protect
 * `& | < > ( ) ^`; `%VAR%` still expands inside them, so each percent steps
 * out of the quotes to be caret-escaped, and a `"` is doubled to keep cmd's
 * quote count even — the encoding @orca/process-host's quoteWindowsCmdArgument
 * uses. Backslashes before a quote are doubled so CommandLineToArgvW keeps them.
 */
function quoteCmdPath(path: string): string {
  let quoted = '"'
  let backslashes = 0
  for (const char of path) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    const quoteBreak = CMD_QUOTE_BREAKS.get(char)
    quoted += quoteBreak
      ? `${'\\'.repeat(backslashes * 2)}${quoteBreak}`
      : `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}
