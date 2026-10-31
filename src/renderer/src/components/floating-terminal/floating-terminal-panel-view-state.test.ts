/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
  persistFloatingTerminalPanelMaximized,
  persistFloatingTerminalPanelOpen,
  readPersistedFloatingTerminalPanelViewState
} from './floating-terminal-panel-view-state'
import { shouldRestoreMaximizedPanelBounds } from './floating-terminal-panel-restore-geometry'

afterEach(() => {
  window.localStorage.clear()
})

describe('floating terminal panel view state', () => {
  it('returns null when nothing was ever persisted', () => {
    expect(readPersistedFloatingTerminalPanelViewState()).toBeNull()
  })

  it('round-trips both flags', () => {
    persistFloatingTerminalPanelOpen(true)
    persistFloatingTerminalPanelMaximized(true)
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({ open: true, maximized: true })
  })

  it('does not clobber the other owner_s flag', () => {
    // Separate owners must preserve each other’s flags when writing view state.
    persistFloatingTerminalPanelMaximized(true)
    persistFloatingTerminalPanelOpen(false)
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({ open: false, maximized: true })

    persistFloatingTerminalPanelOpen(true)
    persistFloatingTerminalPanelMaximized(false)
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({ open: true, maximized: false })
  })

  it('lets a later write destroy a restored open preference', () => {
    // Before settings hydrate, a false feature flag can overwrite restored open state; the app guard must prevent that write.
    persistFloatingTerminalPanelOpen(true)
    expect(readPersistedFloatingTerminalPanelViewState()?.open).toBe(true)

    persistFloatingTerminalPanelOpen(false)
    expect(readPersistedFloatingTerminalPanelViewState()?.open).toBe(false)
  })

  it('restores the half a older record carries', () => {
    window.localStorage.setItem(
      FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ open: true })
    )
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({ open: true, maximized: false })
  })

  it('treats malformed storage as absent instead of throwing', () => {
    for (const value of ['not json', '[]', 'null', '"open"', '42']) {
      window.localStorage.setItem(FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY, value)
      expect(readPersistedFloatingTerminalPanelViewState()).toBeNull()
    }
  })

  it('ignores non-boolean flag values rather than coercing them', () => {
    window.localStorage.setItem(
      FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ open: 'yes', maximized: 1 })
    )
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({ open: false, maximized: false })
  })
})

describe('shouldRestoreMaximizedPanelBounds', () => {
  it('restores maximized geometry only when the viewport can hold it', () => {
    expect(shouldRestoreMaximizedPanelBounds({ open: true, maximized: true }, () => true)).toBe(
      true
    )
    expect(shouldRestoreMaximizedPanelBounds({ open: true, maximized: true }, () => false)).toBe(
      false
    )
  })

  it('does not restore maximized geometry for a non-maximized or absent record', () => {
    expect(shouldRestoreMaximizedPanelBounds({ open: true, maximized: false }, () => true)).toBe(
      false
    )
    expect(shouldRestoreMaximizedPanelBounds(null, () => true)).toBe(false)
  })
})
