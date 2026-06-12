// Why: shared between the runtime (dispatch guard, tui-idle fallback) and the
// renderer (agent-ready-wait, new-workspace). A bare shell is the negative
// signal for "is an agent running" because it garbles injected preambles.
const SHELL_NAMES = new Set(
  '|bash|zsh|sh|fish|cmd|cmd.exe|powershell|powershell.exe|pwsh|pwsh.exe|nu'.split('|')
)

export function isShellProcess(processName: string): boolean {
  const normalized = processName
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  return (
    SHELL_NAMES.has(normalized) || SHELL_NAMES.has(normalized.split(/[\\/]/).pop() ?? normalized)
  )
}
