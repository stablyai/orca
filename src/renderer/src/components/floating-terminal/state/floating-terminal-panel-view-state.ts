export const FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY =
  'orca-floating-terminal-panel-view-state-v1'

export type FloatingTerminalPanelViewState = {
  open: boolean
  maximized: boolean
}

function getWindowStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

/** Persist maximize separately from bounds because its rect comes from the viewport; restore it to avoid reflowing live TUI buffers. */
export function readPersistedFloatingTerminalPanelViewState(): FloatingTerminalPanelViewState | null {
  try {
    const serialized = getWindowStorage()?.getItem(FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY)
    if (!serialized) {
      return null
    }
    const parsed: unknown = JSON.parse(serialized)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Record<string, unknown>
    // Read flags independently so older records still restore the field they contain.
    return {
      open: record.open === true,
      maximized: record.maximized === true
    }
  } catch {
    return null
  }
}

export function persistFloatingTerminalPanelViewState(state: FloatingTerminalPanelViewState): void {
  try {
    getWindowStorage()?.setItem(
      FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
      JSON.stringify(state)
    )
  } catch {
    // Why: storage can be unavailable or full; losing the restore is not worth a crash.
  }
}

// Preserve the other owner’s flag: the app shell writes open, the panel writes maximized.
export function persistFloatingTerminalPanelOpen(open: boolean): void {
  const current = readPersistedFloatingTerminalPanelViewState()
  persistFloatingTerminalPanelViewState({ maximized: current?.maximized === true, open })
}

export function persistFloatingTerminalPanelMaximized(maximized: boolean): void {
  const current = readPersistedFloatingTerminalPanelViewState()
  persistFloatingTerminalPanelViewState({ open: current?.open === true, maximized })
}
