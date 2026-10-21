import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setFitOverride,
  getFitOverrideForPty,
  getFitOverrideForPane,
  bindPanePtyId,
  unbindPane,
  getPaneIdsForPty,
  onOverrideChange,
  hydrateOverrides,
  getAllOverrides,
  getMobileFitOverridePtyIds,
  replaceFitOverridePtyId
} from './mobile-fit-overrides'

afterEach(() => {
  // Reset module-level maps between tests by clearing all overrides
  // and unbinding all known panes.
  hydrateOverrides([])
  // Unbind any panes bound during tests. We don't have direct access
  // to the internal map, but we can unbind known test keys.
  for (const tabId of ['tab-0', 'tab-1', 'tab-2']) {
    for (let paneId = 0; paneId < 5; paneId++) {
      unbindPane(paneId, tabId)
    }
  }
})

// ---------------------------------------------------------------------------
// setFitOverride + getFitOverrideForPty
// ---------------------------------------------------------------------------

describe('setFitOverride / getFitOverrideForPty', () => {
  it('stores a mobile-fit override keyed by ptyId', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    const override = getFitOverrideForPty('pty-1')
    expect(override).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
  })

  it('stores and releases a remote desktop fit hold', () => {
    setFitOverride('pty-remote', 'remote-desktop-fit', 96, 32)
    expect(getFitOverrideForPty('pty-remote')).toEqual({
      mode: 'remote-desktop-fit',
      cols: 96,
      rows: 32
    })

    setFitOverride('pty-remote', 'desktop-fit', 120, 40)
    expect(getFitOverrideForPty('pty-remote')).toBeNull()
  })

  it('removes the override when mode is desktop-fit', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    setFitOverride('pty-1', 'desktop-fit', 120, 40)

    expect(getFitOverrideForPty('pty-1')).toBeNull()
  })

  it('returns null for unknown ptyId', () => {
    expect(getFitOverrideForPty('nonexistent')).toBeNull()
  })

  it('overwrites previous override dimensions', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    setFitOverride('pty-1', 'mobile-fit', 60, 25)

    expect(getFitOverrideForPty('pty-1')).toEqual({ mode: 'mobile-fit', cols: 60, rows: 25 })
  })

  it('tracks multiple ptyIds independently', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    setFitOverride('pty-2', 'mobile-fit', 80, 30)

    expect(getFitOverrideForPty('pty-1')?.cols).toBe(49)
    expect(getFitOverrideForPty('pty-2')?.cols).toBe(80)
  })

  it('moves a fit hold when a provider replaces the PTY identity', () => {
    setFitOverride('pty-old', 'mobile-fit', 49, 20)

    replaceFitOverridePtyId('pty-old', 'pty-new')

    expect(getFitOverrideForPty('pty-old')).toBeNull()
    expect(getFitOverrideForPty('pty-new')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
    expect([...getAllOverrides().keys()]).toEqual(['pty-new'])
  })
})

// ---------------------------------------------------------------------------
// bindPanePtyId + getFitOverrideForPane (tab-scoped composite key)
// ---------------------------------------------------------------------------

describe('bindPanePtyId / getFitOverrideForPane', () => {
  it('resolves override through tab:pane → ptyId → override chain', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    bindPanePtyId(1, 'pty-1', 'tab-0')

    expect(getFitOverrideForPane(1, 'tab-0')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
  })

  it('returns null when tabId is not provided', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    bindPanePtyId(1, 'pty-1', 'tab-0')

    expect(getFitOverrideForPane(1)).toBeNull()
  })

  it('returns null for unbound pane', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    expect(getFitOverrideForPane(1, 'tab-0')).toBeNull()
  })

  it('returns null when ptyId has no override', () => {
    bindPanePtyId(1, 'pty-1', 'tab-0')

    expect(getFitOverrideForPane(1, 'tab-0')).toBeNull()
  })

  it('does not collide when different tabs have the same pane ID', () => {
    setFitOverride('pty-A', 'mobile-fit', 49, 20)
    setFitOverride('pty-B', 'mobile-fit', 80, 30)
    bindPanePtyId(1, 'pty-A', 'tab-0')
    bindPanePtyId(1, 'pty-B', 'tab-1')

    expect(getFitOverrideForPane(1, 'tab-0')?.cols).toBe(49)
    expect(getFitOverrideForPane(1, 'tab-1')?.cols).toBe(80)
  })

  it('clears binding when ptyId is null', () => {
    bindPanePtyId(1, 'pty-1', 'tab-0')
    bindPanePtyId(1, null, 'tab-0')

    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    expect(getFitOverrideForPane(1, 'tab-0')).toBeNull()
  })

  it('is a no-op when tabId is not provided', () => {
    bindPanePtyId(1, 'pty-1')
    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    expect(getFitOverrideForPane(1, 'tab-0')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// unbindPane
// ---------------------------------------------------------------------------

describe('unbindPane', () => {
  it('removes the tab:pane binding', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    bindPanePtyId(1, 'pty-1', 'tab-0')
    unbindPane(1, 'tab-0')

    expect(getFitOverrideForPane(1, 'tab-0')).toBeNull()
  })

  it('does not affect other tabs with the same pane ID', () => {
    setFitOverride('pty-A', 'mobile-fit', 49, 20)
    bindPanePtyId(1, 'pty-A', 'tab-0')
    bindPanePtyId(1, 'pty-A', 'tab-1')

    unbindPane(1, 'tab-0')

    expect(getFitOverrideForPane(1, 'tab-0')).toBeNull()
    expect(getFitOverrideForPane(1, 'tab-1')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
  })

  it('is a no-op when tabId is not provided', () => {
    bindPanePtyId(1, 'pty-1', 'tab-0')
    unbindPane(1)

    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    expect(getFitOverrideForPane(1, 'tab-0')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
  })
})

// ---------------------------------------------------------------------------
// getPaneIdsForPty
// ---------------------------------------------------------------------------

describe('getPaneIdsForPty', () => {
  it('returns pane IDs bound to a ptyId', () => {
    bindPanePtyId(1, 'pty-1', 'tab-0')
    bindPanePtyId(2, 'pty-1', 'tab-0')

    const ids = getPaneIdsForPty('pty-1')
    expect(ids).toEqual(expect.arrayContaining([1, 2]))
    expect(ids).toHaveLength(2)
  })

  it('returns pane IDs across different tabs', () => {
    bindPanePtyId(1, 'pty-1', 'tab-0')
    bindPanePtyId(1, 'pty-1', 'tab-1')

    const ids = getPaneIdsForPty('pty-1')
    expect(ids).toEqual([1, 1])
  })

  it('returns empty array for unknown ptyId', () => {
    expect(getPaneIdsForPty('nonexistent')).toEqual([])
  })

  it('does not include panes bound to a different ptyId', () => {
    bindPanePtyId(1, 'pty-1', 'tab-0')
    bindPanePtyId(2, 'pty-2', 'tab-0')

    expect(getPaneIdsForPty('pty-1')).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// onOverrideChange
// ---------------------------------------------------------------------------

describe('onOverrideChange', () => {
  it('fires listener on mobile-fit override', () => {
    const listener = vi.fn()
    const unsub = onOverrideChange(listener)

    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-1',
      mode: 'mobile-fit',
      cols: 49,
      rows: 20,
      priorCols: null,
      priorRows: null
    })

    unsub()
  })

  it('fires listener on desktop-fit restore', () => {
    const listener = vi.fn()
    const unsub = onOverrideChange(listener)

    setFitOverride('pty-1', 'desktop-fit', 120, 40)

    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-1',
      mode: 'desktop-fit',
      cols: 120,
      rows: 40,
      priorCols: null,
      priorRows: null
    })

    unsub()
  })

  it('passes prior mobile-fit dims to desktop-fit listeners', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    const listener = vi.fn()
    const unsub = onOverrideChange(listener)

    setFitOverride('pty-1', 'desktop-fit', 120, 40)

    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-1',
      mode: 'desktop-fit',
      cols: 120,
      rows: 40,
      priorCols: 49,
      priorRows: 20
    })

    unsub()
  })

  it('unsubscribes cleanly', () => {
    const listener = vi.fn()
    const unsub = onOverrideChange(listener)
    unsub()

    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    expect(listener).not.toHaveBeenCalled()
  })

  it('supports multiple listeners', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = onOverrideChange(a)
    const unsubB = onOverrideChange(b)

    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    unsubA()
    unsubB()
  })
})

// ---------------------------------------------------------------------------
// hydrateOverrides
// ---------------------------------------------------------------------------

describe('hydrateOverrides', () => {
  it('replaces all overrides with the given list', () => {
    setFitOverride('pty-old', 'mobile-fit', 49, 20)

    hydrateOverrides([{ ptyId: 'pty-new', mode: 'mobile-fit', cols: 60, rows: 25 }])

    expect(getFitOverrideForPty('pty-old')).toBeNull()
    expect(getFitOverrideForPty('pty-new')).toEqual({ mode: 'mobile-fit', cols: 60, rows: 25 })
  })

  it('clears all overrides when given an empty list', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)

    hydrateOverrides([])

    expect(getFitOverrideForPty('pty-1')).toBeNull()
  })

  it('hydrates multiple overrides', () => {
    hydrateOverrides([
      { ptyId: 'pty-1', mode: 'mobile-fit', cols: 49, rows: 20 },
      { ptyId: 'pty-2', mode: 'mobile-fit', cols: 80, rows: 30 }
    ])

    expect(getAllOverrides().size).toBe(2)
    expect(getFitOverrideForPty('pty-1')?.cols).toBe(49)
    expect(getFitOverrideForPty('pty-2')?.cols).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// getAllOverrides
// ---------------------------------------------------------------------------

describe('getAllOverrides', () => {
  it('returns a copy of all current overrides', () => {
    setFitOverride('pty-1', 'mobile-fit', 49, 20)
    setFitOverride('pty-2', 'mobile-fit', 80, 30)

    const all = getAllOverrides()
    expect(all.size).toBe(2)

    // Verify it's a copy, not the internal map
    all.delete('pty-1')
    expect(getFitOverrideForPty('pty-1')).not.toBeNull()
  })

  it('excludes remote desktop holds from mobile bulk restore', () => {
    setFitOverride('pty-mobile', 'mobile-fit', 49, 20)
    setFitOverride('pty-remote', 'remote-desktop-fit', 100, 30)

    expect(getMobileFitOverridePtyIds()).toEqual(['pty-mobile'])
  })
})
