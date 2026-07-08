// STA-1282 diagnostics. Breadcrumb log lines on evict / remount / replay-failure
// with the pane id + counts so a future "my terminal came back wrong" report is
// attributable. Breadcrumbs only (telemetry gate: no PostHog events).

type EvictionBreadcrumbEvent = 'evict' | 'remount-claim' | 'remount-replay' | 'self-disable'

export function logTerminalPaneEvictionBreadcrumb(
  event: EvictionBreadcrumbEvent,
  details: {
    tabId?: string
    paneKey?: string
    worktreeId?: string
    ptyId?: string | null
    outcome?: 'ok' | 'nil' | 'error'
    mountedCount?: number
    parkedCount?: number
    reason?: string
  }
): void {
  console.debug(`[terminal-pane-eviction] ${event}`, details)
}
