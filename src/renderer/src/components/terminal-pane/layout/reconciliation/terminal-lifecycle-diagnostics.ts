type TerminalLifecycleDiagnosticDetails = {
  tabId?: string
  worktreeId?: string
  leafId?: string | null
  paneId?: number
  ptyId?: string | null
  reason?: string
}

const emittedDiagnostics = new Set<string>()
const MAX_EMITTED_DIAGNOSTICS = 500

export function warnTerminalLifecycleAnomaly(
  event: string,
  details: TerminalLifecycleDiagnosticDetails
): void {
  const key = [
    event,
    details.tabId ?? '',
    details.worktreeId ?? '',
    details.leafId ?? '',
    details.paneId ?? '',
    details.ptyId ?? '',
    details.reason ?? ''
  ].join('|')
  if (emittedDiagnostics.has(key)) {
    return
  }
  if (emittedDiagnostics.size >= MAX_EMITTED_DIAGNOSTICS) {
    emittedDiagnostics.clear()
  }
  emittedDiagnostics.add(key)
  console.warn(`[terminal-lifecycle] ${event}`, details)
}
