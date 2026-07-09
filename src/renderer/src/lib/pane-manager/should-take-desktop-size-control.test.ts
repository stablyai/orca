import { describe, expect, it } from 'vitest'
import {
  hydrateOverrides,
  setFitOverride,
  shouldTakeDesktopSizeControl
} from './mobile-fit-overrides'

describe('shouldTakeDesktopSizeControl', () => {
  it('does not take control on first proposed observation (baseline)', () => {
    hydrateOverrides([])
    setFitOverride('pty-1', 'remote-desktop-fit', 150, 40)

    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 100, rows: 30 })).toBe(false)
    // Second identical proposal still no take — only changes count.
    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 100, rows: 30 })).toBe(false)
  })

  it('takes control when proposed grid changes while remote-desktop-fit is held', () => {
    hydrateOverrides([])
    setFitOverride('pty-1', 'remote-desktop-fit', 150, 40)

    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 100, rows: 30 })).toBe(false)
    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 110, rows: 30 })).toBe(true)
  })

  it('never takes control for mobile-fit holds', () => {
    hydrateOverrides([])
    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 100, rows: 30 })).toBe(false)
    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 110, rows: 30 })).toBe(false)
  })

  it('does not treat sibling panes on the same PTY as a drag takeover', () => {
    hydrateOverrides([])
    setFitOverride('pty-1', 'remote-desktop-fit', 150, 40)

    // Pane A baseline at 100×30, pane B first sees 80×24 — different grid, same PTY.
    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 100, rows: 30 })).toBe(false)
    expect(shouldTakeDesktopSizeControl('leaf-b', 'pty-1', { cols: 80, rows: 24 })).toBe(false)
    // Only a later change on the *same* binding takes control.
    expect(shouldTakeDesktopSizeControl('leaf-b', 'pty-1', { cols: 90, rows: 24 })).toBe(true)
    expect(shouldTakeDesktopSizeControl('leaf-a', 'pty-1', { cols: 100, rows: 30 })).toBe(false)
  })
})
