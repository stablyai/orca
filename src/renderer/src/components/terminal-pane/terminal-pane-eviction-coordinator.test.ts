import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '@/store'
import {
  __resetTerminalPaneEvictionCoordinatorForTest,
  consumeTerminalPaneEviction,
  noteTerminalPaneVisibility,
  seedTerminalPaneEvictionWarmSetOnEnable
} from './terminal-pane-eviction-coordinator'
import {
  __resetEvictedPaneRegistryForTest,
  isPaneParked,
  recordEvictionRemountReplayOutcome,
  registerEvictedPane
} from './evicted-pane-registry'

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function seedStore(tabIds: string[], overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': tabIds.map(makeTab) },
    ptyIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, [`pty-${id}`]])),
    suppressedPtyExitIds: {},
    settings: {
      ...useAppStore.getState().settings,
      experimentalTerminalPaneEviction: true,
      terminalPaneEvictionWarmBudget: 4,
      terminalPaneEvictionAfterMinutes: 5,
      ...overrides
    } as never,
    terminalPaneMountByTabId: {}
  })
}

async function settle(): Promise<void> {
  // Flush the microtask recompute, then any idle/setTimeout teardown + dwell.
  await Promise.resolve()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(1)
  await Promise.resolve()
}

function mountMap(): Record<string, boolean> {
  return useAppStore.getState().terminalPaneMountByTabId
}

describe('terminal-pane-eviction coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Force the setTimeout idle fallback so teardowns are timer-controlled.
    ;(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined
    __resetTerminalPaneEvictionCoordinatorForTest()
    __resetEvictedPaneRegistryForTest()
  })

  afterEach(() => {
    __resetTerminalPaneEvictionCoordinatorForTest()
    __resetEvictedPaneRegistryForTest()
    vi.useRealTimers()
  })

  it('keeps a just-hidden pane warm-mounted (does not unmount on the switch)', async () => {
    seedStore(['a'])
    noteTerminalPaneVisibility('a', 'wt-1', true)
    await settle()
    noteTerminalPaneVisibility('a', 'wt-1', false)
    // Before the dwell window elapses, the pane stays mounted (Tier 1 warm).
    await Promise.resolve()
    await Promise.resolve()
    expect(mountMap()['a']).toBe(true)
  })

  describe('warm-set population across the visible->hidden transition', () => {
    // Regression: the overlay slot reports a hide only while it is still mounted,
    // and a slot unmounts in the same commit that flips it hidden UNLESS the store
    // warm map already keeps it mounted. So a VISIBLE tab must appear in
    // terminalPaneMountByTabId; otherwise the just-hidden pane unmounts before it
    // can report the hide and the whole managed/warm/park pipeline never engages.
    it('a visible tab is present in the warm mount map (survives the hide render)', async () => {
      seedStore(['a'])
      noteTerminalPaneVisibility('a', 'wt-1', true)
      await settle()
      expect(mountMap()['a']).toBe(true)
    })

    it('report visible then hidden: the pane is brought under management (warm)', async () => {
      seedStore(['a'], { terminalPaneEvictionAfterMinutes: 5 })
      noteTerminalPaneVisibility('a', 'wt-1', true)
      await settle()
      expect(mountMap()['a']).toBe(true)
      // The hide report can only happen because the pane stayed mounted above.
      noteTerminalPaneVisibility('a', 'wt-1', false)
      await settle()
      expect(mountMap()['a']).toBe(true) // warm within dwell
    })

    it('a tab closed while visible is pruned from the warm map on the next recompute', async () => {
      seedStore(['a', 'b'])
      noteTerminalPaneVisibility('a', 'wt-1', true)
      await settle()
      expect(mountMap()['a']).toBe(true)
      // Close tab a while it is visible (it never reports hidden), then drive a
      // recompute by reporting b hidden. Stale visible ids must not leak.
      useAppStore.setState({ tabsByWorktree: { 'wt-1': [makeTab('b')] } })
      noteTerminalPaneVisibility('b', 'wt-1', false)
      await settle()
      expect(mountMap()['a']).toBeUndefined()
      expect(mountMap()['b']).toBe(true)
    })
  })

  describe('enable-time warm-set seed (runtime flag flip, STA-1282)', () => {
    it('synchronously seeds every non-parked tab into the warm mount map', () => {
      // Called by the settings toggle BEFORE the enabling settings write, so it
      // must work while the flag is still OFF — the mount map must be populated
      // in the same tick, before the enable render evaluates the mount gate
      // (otherwise every hidden mounted pane mass-DETACHES instead of parking).
      seedStore(['a', 'b', 'c'], { experimentalTerminalPaneEviction: false })
      // A parked tab stays Tier-2 (claimable on demand) — never re-warmed.
      registerEvictedPane({
        paneKey: 'tab-c-leaf',
        tabId: 'c',
        worktreeId: 'wt-1',
        getPtyId: () => 'pty-c',
        destroy: vi.fn(),
        releaseForClaim: vi.fn()
      })
      seedTerminalPaneEvictionWarmSetOnEnable()
      expect(mountMap()['a']).toBe(true)
      expect(mountMap()['b']).toBe(true)
      expect(mountMap()['c']).toBeUndefined()
    })

    it('seeded panes age out through the normal dwell policy with the park signal', async () => {
      seedStore(['a', 'b'], { terminalPaneEvictionAfterMinutes: 5 })
      seedTerminalPaneEvictionWarmSetOnEnable()
      await settle()
      expect(mountMap()['a']).toBe(true)
      // Past the dwell window the seeded panes evict through the ordinary idle
      // teardown, raising the eviction signal so the lifecycle parks (not detach).
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 5)
      await settle()
      expect(mountMap()['a']).toBeUndefined()
      expect(consumeTerminalPaneEviction('a')).toBe(true)
    })
  })

  it('evicts a hidden pane once it passes the dwell window (deferred teardown)', async () => {
    seedStore(['a'], { terminalPaneEvictionAfterMinutes: 1 })
    noteTerminalPaneVisibility('a', 'wt-1', false)
    await settle()
    expect(mountMap()['a']).toBe(true) // warm within dwell

    // Advance past the 1-minute dwell: the lazy dwell timer fires a recompute,
    // which schedules and (on the idle callback) runs the deferred teardown.
    await vi.advanceTimersByTimeAsync(61_000)
    await settle()
    expect(consumeTerminalPaneEviction('a')).toBe(true)
    expect(mountMap()['a']).toBeUndefined()
  })

  it('gate #9: switching back before the dwell elapses keeps the pane warm (no eviction)', async () => {
    seedStore(['a'], { terminalPaneEvictionAfterMinutes: 1 })
    noteTerminalPaneVisibility('a', 'wt-1', false)
    await settle()
    await vi.advanceTimersByTimeAsync(30_000) // still within dwell
    // Switch back to the tab (re-warm / remount claim) — bumps the generation.
    noteTerminalPaneVisibility('a', 'wt-1', true)
    await settle()
    // Advance well past the ORIGINAL dwell boundary; a stale teardown must not fire.
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(consumeTerminalPaneEviction('a')).toBe(false)
  })

  it('disable reconciliation: flipping the kill switch off stops evictions', async () => {
    seedStore(['a'], { terminalPaneEvictionAfterMinutes: 1 })
    noteTerminalPaneVisibility('a', 'wt-1', false)
    await settle()
    // Turn eviction off, then advance past the dwell window.
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        experimentalTerminalPaneEviction: false
      } as never
    })
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    // No eviction: the pane stays mounted (warm) because eviction is disabled.
    expect(consumeTerminalPaneEviction('a')).toBe(false)
    expect(mountMap()['a']).toBe(true)
  })

  it('gate #5: tripping the fail-open self-disable stops further evictions', async () => {
    seedStore(['a'], { terminalPaneEvictionAfterMinutes: 1 })
    noteTerminalPaneVisibility('a', 'wt-1', false)
    await settle()
    // Trip the per-session self-disable (3 structural replay failures). The
    // coordinator's onEvictionSelfDisable listener cancels pending teardowns.
    recordEvictionRemountReplayOutcome('error')
    recordEvictionRemountReplayOutcome('error')
    recordEvictionRemountReplayOutcome('error')
    await settle()
    // Even past the dwell window, the pane is not evicted (eviction self-disabled).
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(consumeTerminalPaneEviction('a')).toBe(false)
    expect(mountMap()['a']).toBe(true)
  })

  describe('gate #8 close-reconcile for a background parked tab (finding #4)', () => {
    function parkedEntry(tabId: string, destroy: () => void) {
      return {
        paneKey: `${tabId}:leaf`,
        tabId,
        worktreeId: 'wt-1',
        getPtyId: () => `pty-${tabId}`,
        destroy,
        releaseForClaim: vi.fn()
      }
    }

    it('closing a background parked tab (not in managedTabs) destroys its entry + kills its PTY promptly', async () => {
      // Bring the coordinator online with one managed (hidden) tab so its store
      // subscription is active, and park a DIFFERENT background tab.
      seedStore(['a', 'parked'])
      noteTerminalPaneVisibility('a', 'wt-1', false)
      await settle()

      const destroy = vi.fn()
      registerEvictedPane(parkedEntry('parked', destroy))
      expect(isPaneParked('parked:leaf')).toBe(true)

      // Close the background parked tab: it is NOT in managedTabs, so only the
      // parked-owner liveness folded into the change signature moves the
      // signature and triggers the registry close-reconcile.
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [makeTab('a')] }
      })
      await settle()

      expect(destroy).toHaveBeenCalledTimes(1) // PTY killed promptly
      expect(isPaneParked('parked:leaf')).toBe(false)
    })
  })

  describe('flag-OFF inertness (finding #1)', () => {
    function setEvictionSetting(enabled: boolean): void {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          experimentalTerminalPaneEviction: enabled
        } as never
      })
    }

    it('disabled from start: reporting a pane never subscribes to the store or records state', () => {
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [makeTab('a')] },
        ptyIdsByTabId: { a: ['pty-a'] },
        terminalPaneMountByTabId: {},
        settings: {
          ...useAppStore.getState().settings,
          experimentalTerminalPaneEviction: false
        } as never
      })
      const subscribeSpy = vi.spyOn(useAppStore, 'subscribe')
      // Both a hide and a show report — neither may activate the coordinator.
      noteTerminalPaneVisibility('a', 'wt-1', false)
      noteTerminalPaneVisibility('a', 'wt-1', true)
      expect(subscribeSpy).not.toHaveBeenCalled()
      // No warm set was written (the overlay mounts everything when disabled).
      expect(mountMap()['a']).toBeUndefined()
      subscribeSpy.mockRestore()
    })

    it('enabling at runtime activates: a reported hidden pane becomes warm then evicts past dwell', async () => {
      // Seed disabled: reporting is inert.
      seedStore(['a'], {
        experimentalTerminalPaneEviction: false,
        terminalPaneEvictionAfterMinutes: 1
      })
      noteTerminalPaneVisibility('a', 'wt-1', false)
      await settle()
      expect(mountMap()['a']).toBeUndefined() // inert while disabled

      // Flip ON at runtime, then the overlay reporter re-fires for the pane.
      setEvictionSetting(true)
      noteTerminalPaneVisibility('a', 'wt-1', false)
      await settle()
      expect(mountMap()['a']).toBe(true) // now warm-mounted (coordinator active)

      await vi.advanceTimersByTimeAsync(61_000)
      await settle()
      expect(consumeTerminalPaneEviction('a')).toBe(true) // evicts past dwell
      expect(mountMap()['a']).toBeUndefined()
    })

    it('disabling at runtime deactivates and cancels a scheduled teardown', async () => {
      // Capture idle teardown callbacks so we control exactly when they run.
      const idleCallbacks = new Map<number, () => void>()
      let nextIdleId = 1
      ;(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: () => void) => {
        const id = nextIdleId++
        idleCallbacks.set(id, cb)
        return id
      }
      ;(globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = (id: number) => {
        idleCallbacks.delete(id)
      }

      seedStore(['a'], { terminalPaneEvictionAfterMinutes: 1 })
      noteTerminalPaneVisibility('a', 'wt-1', false)
      await settle()
      // Past dwell: the dwell timer fires a recompute that SCHEDULES (does not
      // run) the idle teardown.
      await vi.advanceTimersByTimeAsync(61_000)
      await settle()
      expect(idleCallbacks.size).toBe(1)

      // Flip OFF before the idle teardown runs: deactivation cancels it.
      setEvictionSetting(false)
      await settle()
      expect(idleCallbacks.size).toBe(0) // canceled — never fires

      // Even running any stragglers, the pane is not evicted and stays mounted.
      for (const cb of idleCallbacks.values()) {
        cb()
      }
      expect(consumeTerminalPaneEviction('a')).toBe(false)
      expect(mountMap()['a']).toBe(true)

      ;(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined
      ;(globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = undefined
    })
  })

  describe('hot-path: unrelated store ticks do not churn the warm set (perf)', () => {
    it('flag ON with a warm pane: a burst of unrelated store ticks triggers zero warm-set writes', async () => {
      // The coordinator subscribes to the WHOLE store, so every set() app-wide
      // runs its subscriber (e.g. an active terminal's status/title/git ticks).
      // The signature short-circuit + the shallowEqual pushMountMap gate must
      // keep a tick that touches a field eviction never reads from recomputing or
      // rewriting the warm set. This regresses to per-tick store churn if the
      // signature is dropped/always-changing or pushMountMap loses its gate.
      seedStore(['a', 'b'])
      noteTerminalPaneVisibility('a', 'wt-1', false)
      await settle()
      expect(mountMap()['a']).toBe(true) // warm within dwell

      const warmSetBefore = mountMap()
      let warmSetWrites = 0
      const unsubscribe = useAppStore.subscribe((state, prev) => {
        if (state.terminalPaneMountByTabId !== prev.terminalPaneMountByTabId) {
          warmSetWrites += 1
        }
      })
      for (let i = 0; i < 50; i++) {
        useAppStore.setState({ __unrelatedHotTick: i } as never)
      }
      await settle()
      unsubscribe()

      expect(warmSetWrites).toBe(0)
      // Same object identity: the coordinator never rewrote the warm set.
      expect(mountMap()).toBe(warmSetBefore)
    })
  })
})
