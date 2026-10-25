// Why: shared between the runtime (dispatch guard, tui-idle fallback) and the
// renderer (agent-ready-wait, new-workspace). A bare shell is the negative
// signal for "is an agent running" because it garbles injected preambles.
const SHELL_NAMES = new Set(
  '|bash|zsh|sh|fish|cmd|cmd.exe|powershell|powershell.exe|pwsh|pwsh.exe|nu|ksh|mksh|dash|ash|tcsh|csh|elvish|xonsh'.split(
    '|'
  )
)
const WINDOWS_PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i

export function isShellProcess(processName: string): boolean {
  const normalized = processName
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  const basename = normalized.split(/[\\/]/).pop() ?? normalized
  // Why: Windows node-pty reports Git Bash and similar shells as `bash.exe`;
  // those still need the same shell-safe handling as their POSIX basenames.
  const basenameWithoutWindowsExtension = basename.replace(WINDOWS_PROCESS_EXTENSION_RE, '')
  return (
    SHELL_NAMES.has(normalized) ||
    SHELL_NAMES.has(basename) ||
    SHELL_NAMES.has(basenameWithoutWindowsExtension)
  )
}

// Why: Git for Windows' prompt titles the pane `$MSYSTEM:$PWD` (`MINGW64:/c/repo`), and Git Bash
// has no command marks, so that repaint is the only sign an agent there handed back to the shell.
const MSYS_PROMPT_TITLE_RE = /^(?:MINGW(?:32|64)|MSYS|UCRT64|CLANG(?:32|64|ARM64)):\//

/** A shell name, a Git Bash prompt title, or the tab's neutral default title; blank is no evidence. */
export function titleShowsNoAgent(title: string, defaultTitle?: string): boolean {
  const trimmed = title.trim()
  return (
    trimmed.length > 0 &&
    (isShellProcess(trimmed) ||
      MSYS_PROMPT_TITLE_RE.test(trimmed) ||
      trimmed === defaultTitle?.trim())
  )
}

// Why: a ConPTY-side buffer clear cannot reach PSReadLine's cached cursor
// row, so the first Enter after a terminal clear still repaints the prompt at
// the stale row. Only the PowerShell family binds Ctrl+L (form feed) to a
// full prompt repaint, so the post-clear nudge must stay scoped to it.
const POWERSHELL_NAMES = new Set(['powershell', 'pwsh'])

export function isPowerShellProcess(processName: string | null | undefined): boolean {
  if (!processName) {
    return false
  }
  const normalized = processName
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  const basename = normalized.split(/[\\/]/).pop() ?? normalized
  return POWERSHELL_NAMES.has(basename.replace(WINDOWS_PROCESS_EXTENSION_RE, ''))
}
