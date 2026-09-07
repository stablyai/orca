export const FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY =
  'orca-floating-terminal-panel-view-state-v1'

export type FloatingTerminalPanelViewState = {
  open: boolean
  maximized: boolean
}

function getWindowStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

/**
 * Why persisted separately from the bounds record: maximized geometry is derived
 * from the live viewport rather than stored, so this is view state, not a rect.
 * Keeping it out of the bounds union also keeps that type a pure rectangle.
 *
 * Why it matters: an unpersisted maximize means every restart drops the user into
 * a default-sized panel that they re-maximize by hand. That size jump reflows the
 * xterm buffer under a live relative-cursor TUI, which unwraps its rows and leaves
 * permanently mangled scrollback. Restoring the panel as it was removes the jump.
 */
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
    // Why each flag is read independently: a record written before the other flag
    // existed must still restore the half it does carry.
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

// Why field-scoped writers: `open` is owned by the app shell and `maximized` by the panel,
// so a whole-record write from either side would clobber the other's flag.
export function persistFloatingTerminalPanelOpen(open: boolean): void {
  const current = readPersistedFloatingTerminalPanelViewState()
  persistFloatingTerminalPanelViewState({ maximized: current?.maximized === true, open })
}

export function persistFloatingTerminalPanelMaximized(maximized: boolean): void {
  const current = readPersistedFloatingTerminalPanelViewState()
  persistFloatingTerminalPanelViewState({ open: current?.open === true, maximized })
}
