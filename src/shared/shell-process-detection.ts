// Share bare-shell detection across runtime/renderer to avoid injecting agent preambles into an ordinary shell.
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
  // node-pty reports Windows shells as bash.exe; strip extensions for the same shell-safe treatment.
  const basenameWithoutWindowsExtension = basename.replace(WINDOWS_PROCESS_EXTENSION_RE, '')
  return (
    SHELL_NAMES.has(normalized) ||
    SHELL_NAMES.has(basename) ||
    SHELL_NAMES.has(basenameWithoutWindowsExtension)
  )
}

// Git Bash has no command marks; MSYSTEM:PWD prompt repaint is its agent-to-shell signal.
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

// ConPTY clear cannot reset PSReadLine’s cached cursor; scope Ctrl+L repaint to PowerShell, the family that binds it.
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
