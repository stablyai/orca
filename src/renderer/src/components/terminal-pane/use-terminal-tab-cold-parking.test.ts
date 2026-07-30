// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  storeState: {
    pendingStartupByTabId: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  },
  exemptTabIds: new Set<string>(),
  exemptSelectCalls: 0
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState)
}))

vi.mock('./terminal-eviction-exempt-tabs', () => ({
  selectEvictionExemptTerminalTabIds: (_worktreeId: string, tabs: readonly { id: string }[]) => {
    mocks.exemptSelectCalls += 1
    return new Set(tabs.filter((tab) => mocks.exemptTabIds.has(tab.id)).map((tab) => tab.id))
  },
  selectEvictionExemptTerminalTabLayoutKey: (
    state: typeof mocks.storeState,
    tabs: readonly { id: string }[]
  ) =>
    tabs
      .map(
        (tab) => `${tab.id}=${JSON.stringify(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId)}`
      )
      .join('|')
}))

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  syncParkedTerminalTabWatchers: vi.fn()
}))

import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const WORKTREE_ID = 'wt-1'

function terminalTab(id: string): TerminalTab {
  return { id, ptyId: `${WORKTREE_ID}@@session-${id}` } as TerminalTab
}

function hookArgs(shouldMeasureHiddenWorktree: boolean) {
  return {
    worktreeId: WORKTREE_ID,
    terminalTabs: [terminalTab('tab-1'), terminalTab('tab-2')],
    assignments: new Map<string, { groupId: string; isActiveInGroup: boolean }>(),
    isWorktreeActive: false,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals: [],
    activationDeferredMountTabIds: null
  }
}

describe('useTerminalTabColdParking measure-clock contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    mocks.exemptTabIds = new Set()
    mocks.exemptSelectCalls = 0
    mocks.storeState.terminalLayoutsByTabId = {}
  })

  // Why: the worktree layer preserves hiddenSince through a background-measure
  // window; the tab layer must share that contract (no clock reset) while a
  // post-measure cool-down prevents the instant re-park thrash.
  it('preserves tab hiddenSince through a measure window and re-parks only after the cool-down', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )
    expect(result.current.size).toBe(0)

    // Past hot-retain: tab-1 holds the last-active exemption, tab-2 parks.
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    // A measure window reveals every tab but must not clear the hidden clock.
    act(() => {
      rerender(hookArgs(true))
    })
    expect(result.current.size).toBe(0)
    act(() => {
      vi.advanceTimersByTime(3_000)
      rerender(hookArgs(false))
    })

    // Measure just ended: the cool-down vetoes an instant re-park (the thrash).
    expect(result.current.size).toBe(0)
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_COLD_PARK_DELAY_MS - 1)
    })
    expect(result.current.size).toBe(0)

    // One cool-down later tab-2 re-parks — proving hiddenSince survived the
    // measure (a cleared clock would demand a fresh 15-minute hot-retain).
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Why: a measure window also ends when the user opens the worktree; the
  // hysteresis is then owed to nobody, so still-hidden background tabs must not
  // sit out a cool-down (Terminal.tsx clears the worktree clock the same way).
  it('clears the post-measure cool-down when the worktree becomes visible', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )

    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    act(() => {
      rerender(hookArgs(true))
    })
    expect(result.current.size).toBe(0)

    // Measure ends because the worktree went visible: tab-2 is still hidden
    // (no active group assignment) and re-parks on this very pass.
    act(() => {
      vi.advanceTimersByTime(3_000)
      rerender({ ...hookArgs(false), isWorktreeActive: true })
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Why: force-park is the only park that can contain unrestorable ptys, so its
  // exempt tabs keep their panes — a remount would orphan a live shell.
  it('keeps eviction-exempt tabs mounted when the worktree is force-parked', () => {
    mocks.exemptTabIds = new Set(['tab-1'])
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs> & { isForceParked: boolean }) =>
        useTerminalTabColdParking(args),
      { initialProps: { ...hookArgs(false), coldParkTerminalPanes: true, isForceParked: true } }
    )
    expect(result.current).toEqual(new Set(['tab-2']))

    // The carve-out is scoped to force-parks: an ordinary worktree park has no
    // exempt tabs to protect, so it evicts both.
    act(() => {
      rerender({ ...hookArgs(false), coldParkTerminalPanes: true, isForceParked: false })
    })
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))
  })

  // Why: a split lands in the layout store, not in terminalTabs — a memo keyed
  // on the tabs alone would keep serving a set that misses the new pane and
  // unmount the live shell it should have exempted.
  it('re-resolves exemptions when only the layout PTYs change', () => {
    const stableArgs = { ...hookArgs(false), coldParkTerminalPanes: true, isForceParked: true }
    const { result, rerender } = renderHook(
      (args: typeof stableArgs) => useTerminalTabColdParking(args),
      { initialProps: stableArgs }
    )
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    // Same tabs, same verdict: nothing the memo can see has moved yet.
    mocks.exemptTabIds = new Set(['tab-1'])
    act(() => {
      rerender(stableArgs)
    })
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    // The split's leaf pty lands in the layout store and re-keys the memo.
    mocks.storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { 'leaf-2': 'pty-local-detached' } }
    }
    act(() => {
      rerender(stableArgs)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Why: resolving an exemption re-reads the store and walks the layout tree per
  // tab, so an unrelated re-render must not repeat that work.
  it('resolves eviction exemptions once per force-park input change', () => {
    mocks.exemptTabIds = new Set(['tab-1'])
    const stableArgs = { ...hookArgs(false), coldParkTerminalPanes: true, isForceParked: true }
    const { result, rerender } = renderHook(
      (args: typeof stableArgs) => useTerminalTabColdParking(args),
      { initialProps: stableArgs }
    )
    expect(result.current).toEqual(new Set(['tab-2']))
    const callsAfterFirstRender = mocks.exemptSelectCalls

    act(() => {
      rerender({ ...stableArgs, isWorktreeActive: false })
    })
    expect(mocks.exemptSelectCalls).toBe(callsAfterFirstRender)
    expect(result.current).toEqual(new Set(['tab-2']))
  })
})
