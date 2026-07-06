import { recordRendererCrashBreadcrumb } from '../../lib/crash-diagnostics'

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
  // Why: worktree and PTY ids can reveal local path/session details, so crash
  // breadcrumbs keep only their presence while preserving stable pane ids.
  recordRendererCrashBreadcrumb('terminal_lifecycle_anomaly', {
    event,
    tabId: details.tabId ?? null,
    leafId: details.leafId ?? null,
    paneId: details.paneId ?? null,
    reason: details.reason ?? null,
    hasWorktreeId: Boolean(details.worktreeId),
    hasPtyId: Boolean(details.ptyId)
  })
}
