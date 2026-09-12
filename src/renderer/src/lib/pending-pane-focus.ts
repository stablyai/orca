import type { FocusTerminalPaneDetail } from '@/constants/terminal'

// Why: activateTabAndFocusPane dispatches FOCUS_TERMINAL_PANE_EVENT one frame
// after setActiveTab. A cold-parked TerminalPane (hidden worktree, background
// tab) mounts its listener several frames later — or behind an SSH connect
// gate — so the dispatch lands on no listener and click-to-focus is silently
// lost. Park the detail here so the mounting pane consumes it on the way up.
const PENDING_FOCUS_TTL_MS = 15_000

type PendingFocusEntry = {
  detail: FocusTerminalPaneDetail
  queuedAt: number
}

const pendingByTabId = new Map<string, PendingFocusEntry>()

export function queuePaneFocus(tabId: string, detail: FocusTerminalPaneDetail): void {
  pendingByTabId.set(tabId, { detail, queuedAt: Date.now() })
}

export function consumePendingPaneFocus(tabId: string): FocusTerminalPaneDetail | null {
  const entry = pendingByTabId.get(tabId)
  if (!entry) {
    return null
  }
  pendingByTabId.delete(tabId)
  if (Date.now() - entry.queuedAt > PENDING_FOCUS_TTL_MS) {
    return null
  }
  return entry.detail
}

export function clearPendingPaneFocus(tabId: string): void {
  pendingByTabId.delete(tabId)
}
