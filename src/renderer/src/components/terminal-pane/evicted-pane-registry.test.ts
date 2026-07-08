import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEvictedPaneRegistryForTest,
  claimEvictedPane,
  evictedPaneCount,
  forgetEvictedPaneOnExit,
  getEvictedPane,
  isEvictionSelfDisabled,
  isPaneParked,
  isTabParked,
  onEvictionSelfDisable,
  parkedTabIds,
  recordEvictionRemountReplayOutcome,
  reconcileEvictedPanes,
  registerEvictedPane,
  type EvictedPaneEntry
} from './evicted-pane-registry'

afterEach(() => __resetEvictedPaneRegistryForTest())

function entry(overrides: Partial<EvictedPaneEntry> & { paneKey: string }): EvictedPaneEntry {
  return {
    tabId: overrides.paneKey,
    worktreeId: 'wt-1',
    getPtyId: () => `pty-${overrides.paneKey}`,
    destroy: vi.fn(),
    releaseForClaim: vi.fn(),
    ...overrides
  }
}

describe('evicted-pane registry', () => {
  it('registers and reports parked panes', () => {
    registerEvictedPane(entry({ paneKey: 'a' }))
    expect(isPaneParked('a')).toBe(true)
    expect(isPaneParked('b')).toBe(false)
  })

  it('reports a tab as parked when any of its leaves is parked', () => {
    registerEvictedPane(entry({ paneKey: 'tab1:leaf1', tabId: 'tab1' }))
    registerEvictedPane(entry({ paneKey: 'tab1:leaf2', tabId: 'tab1' }))
    expect(isTabParked('tab1')).toBe(true)
    expect(parkedTabIds()).toEqual(new Set(['tab1']))
  })

  it('disposes a stale entry when a pane is re-parked (no double-parked PTY)', () => {
    const stale = entry({ paneKey: 'a' })
    registerEvictedPane(stale)
    registerEvictedPane(entry({ paneKey: 'a' }))
    expect(stale.destroy).toHaveBeenCalledTimes(1)
  })

  it('claim hands the PTY back without killing it', () => {
    const e = entry({ paneKey: 'a' })
    registerEvictedPane(e)
    expect(claimEvictedPane('a')).toBe(true)
    expect(e.releaseForClaim).toHaveBeenCalledTimes(1)
    expect(e.destroy).not.toHaveBeenCalled()
    expect(isPaneParked('a')).toBe(false)
  })

  it('claim of an unparked pane returns false', () => {
    expect(claimEvictedPane('missing')).toBe(false)
  })

  it('forgets a parked pane whose PTY exited without killing it again', () => {
    const e = entry({ paneKey: 'a' })
    registerEvictedPane(e)
    forgetEvictedPaneOnExit('a')
    expect(e.destroy).not.toHaveBeenCalled()
    expect(e.releaseForClaim).toHaveBeenCalledTimes(1)
    expect(isPaneParked('a')).toBe(false)
  })

  describe('close-reconcile (gate #8)', () => {
    it('kills a parked pane whose tab is gone', () => {
      const e = entry({ paneKey: 'a', tabId: 'tab-a', worktreeId: 'wt-1' })
      registerEvictedPane(e)
      reconcileEvictedPanes({ tabIds: new Set(), worktreeIds: new Set(['wt-1']) })
      expect(e.destroy).toHaveBeenCalledTimes(1)
      expect(isPaneParked('a')).toBe(false)
    })

    it('kills a parked pane whose worktree is gone', () => {
      const e = entry({ paneKey: 'a', tabId: 'tab-a', worktreeId: 'wt-gone' })
      registerEvictedPane(e)
      reconcileEvictedPanes({ tabIds: new Set(['tab-a']), worktreeIds: new Set(['wt-1']) })
      expect(e.destroy).toHaveBeenCalledTimes(1)
    })

    it('keeps a parked pane whose tab and worktree both still exist', () => {
      const e = entry({ paneKey: 'a', tabId: 'tab-a', worktreeId: 'wt-1' })
      registerEvictedPane(e)
      reconcileEvictedPanes({ tabIds: new Set(['tab-a']), worktreeIds: new Set(['wt-1']) })
      expect(e.destroy).not.toHaveBeenCalled()
      expect(isPaneParked('a')).toBe(true)
    })
  })

  describe('fail-open counter (gate #5)', () => {
    it('self-disables only after N structural failures, not on nil/ok', () => {
      const listener = vi.fn()
      onEvictionSelfDisable(listener)
      recordEvictionRemountReplayOutcome('nil')
      recordEvictionRemountReplayOutcome('ok')
      recordEvictionRemountReplayOutcome('nil')
      expect(isEvictionSelfDisabled()).toBe(false)
      recordEvictionRemountReplayOutcome('error')
      recordEvictionRemountReplayOutcome('error')
      expect(isEvictionSelfDisabled()).toBe(false)
      recordEvictionRemountReplayOutcome('error')
      expect(isEvictionSelfDisabled()).toBe(true)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('does not miscount a nil mirror as a failure', () => {
      for (let i = 0; i < 10; i++) {
        recordEvictionRemountReplayOutcome('nil')
      }
      expect(isEvictionSelfDisabled()).toBe(false)
    })
  })

  // Perf budget item (d2): the registry is the ONE place parked state lives while
  // a pane is unmounted. It must stay bounded by the number of evicted live PTYs
  // (not evict cycles) and must hold no renderer render-state (no xterm, DOM, or
  // scrollback buffer) — those are exactly what eviction tore down.
  describe('perf budget d2 (bounded, no renderer render-state)', () => {
    it('is bounded by the count of distinct evicted live PTYs, not by evict cycles', () => {
      // A 40-agent workspace parks ~40 entries — the aggregate ceiling the budget
      // asserts (orders of magnitude below the mounted-xterm cost this removes).
      for (let i = 0; i < 40; i++) {
        registerEvictedPane(entry({ paneKey: `pane-${i}`, tabId: `tab-${i}` }))
      }
      expect(evictedPaneCount()).toBe(40)

      // Repeated evict cycles of the SAME panes re-park in place (each re-park
      // disposes the stale entry), so the registry never grows past distinct PTYs.
      for (let cycle = 0; cycle < 5; cycle++) {
        for (let i = 0; i < 40; i++) {
          registerEvictedPane(entry({ paneKey: `pane-${i}`, tabId: `tab-${i}` }))
        }
      }
      expect(evictedPaneCount()).toBe(40)
    })

    it('holds only bounded metadata per entry — no xterm/DOM/scrollback buffer', () => {
      registerEvictedPane(entry({ paneKey: 'a' }))
      const parked = getEvictedPane('a')
      expect(parked).toBeDefined()
      // The entry is a tiny constant: ids + lifecycle callbacks.
      // Anything retaining renderer render-state (an xterm instance, a DOM node,
      // a scrollback buffer) would violate the d2 budget, so the shape is pinned.
      expect(new Set(Object.keys(parked as object))).toEqual(
        new Set(['paneKey', 'tabId', 'worktreeId', 'getPtyId', 'destroy', 'releaseForClaim'])
      )
    })
  })
})
