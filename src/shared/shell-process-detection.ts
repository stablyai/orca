// Why: shared between the runtime (dispatch guard, tui-idle fallback) and the
// renderer (agent-ready-wait, new-workspace). A bare shell is the negative
// signal for "is an agent running" because it garbles injected preambles.
const SHELL_NAMES = new Set(
  '|bash|zsh|sh|fish|cmd|cmd.exe|powershell|powershell.exe|pwsh|pwsh.exe|nu'.split('|')
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
