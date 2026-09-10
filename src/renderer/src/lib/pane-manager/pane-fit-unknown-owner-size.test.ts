import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProposedPaneFitDimensions, safeFit } from './pane-fit'
import { getFitOverrideForPty, hydrateOverrides, setFitOverride } from './mobile-fit-overrides'
import type { ManagedPane } from './pane-manager-types'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))
afterEach(() => hydrateOverrides([]))

function createPane(width = 649): ManagedPane {
  const terminal = {
    cols: 120,
    rows: 40,
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    })
  }
  return {
    terminal,
    container: {
      dataset: { ptyId: 'held-pty' },
      getBoundingClientRect: () => ({ width, height: 964 })
    },
    fitAddon: {
      proposeDimensions: vi.fn(() => ({ cols: 75, rows: 60 })),
      fit: vi.fn(() => terminal.resize(75, 60))
    }
  } as unknown as ManagedPane
}

describe('safeFit with an owner whose geometry is unknown', () => {
  it.each(['remote-desktop-fit', 'mobile-fit'] as const)(
    'retains the %s hold while fitting locally',
    (mode) => {
      const pane = createPane()
      setFitOverride('held-pty', mode, 0, 0)
      expect(readProposedPaneFitDimensions(pane)).toEqual({ cols: 75, rows: 60 })
      expect(safeFit(pane)).toBe(true)
      expect(pane.terminal.resize).toHaveBeenCalledWith(75, 60)
      expect(pane.terminal.resize).not.toHaveBeenCalledWith(0, 0)
      expect(getFitOverrideForPty('held-pty')).toEqual({ mode, cols: 0, rows: 0 })
      setFitOverride('held-pty', mode, 2, 1)
      expect(safeFit(pane)).toBe(true)
      expect(pane.terminal.resize).toHaveBeenLastCalledWith(2, 1)
    }
  )

  it.each([Number.NaN, Infinity, -1])('does not apply invalid owner dimension %s', (cols) => {
    const pane = createPane()
    setFitOverride('held-pty', 'remote-desktop-fit', cols, 40)
    expect(safeFit(pane)).toBe(true)
    expect(pane.terminal.resize).toHaveBeenCalledWith(75, 60)
    expect(getFitOverrideForPty('held-pty')?.cols).toBe(cols)
  })

  it('does not guess a hidden destination grid', () => {
    const pane = createPane(0)
    setFitOverride('held-pty', 'remote-desktop-fit', 0, 0)
    expect(readProposedPaneFitDimensions(pane)).toBeNull()
    expect(safeFit(pane)).toBe(false)
    expect(pane.terminal.resize).not.toHaveBeenCalled()
    expect(getFitOverrideForPty('held-pty')).not.toBeNull()
  })
})
