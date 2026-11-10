// @vitest-environment happy-dom
import type * as ParkedWatcherRegistryModule from '../output-watchers/terminal-parked-watcher-registry'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

const mocks = vi.hoisted(() => ({
  storeState: {
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, { ptyIdsByLeafId?: Record<string, string> }>,
    // An empty catalog makes the unexercised capture repo gate preserve scrollback.
    repos: [],
    sleepingAgentSessionsByPaneKey: {} as Record<
      string,
      { paneKey: string; tabId?: string; worktreeId: string }
    >
  },
  exemptTabIds: new Set<string>(),
  /** Toggled to churn the park verdict the way the crash cluster does. */
  watcherCoverage: true
}))

vi.mock('../../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(mocks.storeState),
    { getState: () => mocks.storeState }
  )
}))

vi.mock('../retention/terminal-eviction-exempt-tabs', () => ({
  selectEvictionExemptTerminalTabIds: (_worktreeId: string, tabs: readonly { id: string }[]) => {
    return new Set(tabs.filter((tab) => mocks.exemptTabIds.has(tab.id)).map((tab) => tab.id))
  }
}))

vi.mock('../output-watchers/terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => mocks.watcherCoverage,
  syncParkedTerminalTabWatchers: vi.fn()
}))

vi.mock('../output-watchers/terminal-parked-watcher-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedWatcherRegistryModule>()),
  disposeParkedTerminalWatchersForWorktree: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_MS
} from '../retention/terminal-hidden-view-parking'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
  TERMINAL_TAB_PARK_FLIP_WINDOW_MS
} from '../verdict/terminal-park-verdict-flip-telemetry'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../../../terminal/background-terminal-worktree-visibility'
import { queueTerminalPaneSplitRequest } from '../../layout/split/terminal-pane-split-request-routing'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import { invalidateTerminalParkingInputs } from '../terminal-parking-input-events'

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
    activeTerminalTabId: null as string | null,
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
    mocks.watcherCoverage = true
    mocks.storeState.terminalLayoutsByTabId = {}
    mocks.storeState.sleepingAgentSessionsByPaneKey = {}
    mocks.storeState.runtimeStatusByEnvironmentId = new Map()
  })

  // Why: leaving a worktree gives every tab the same hidden time.
  it('exempts the tab the worktree was left on when every tab hides in one pass', () => {
    const assignments = new Map([
      ['tab-1', { groupId: 'group-1', isActiveInGroup: false }],
      ['tab-2', { groupId: 'group-1', isActiveInGroup: true }]
    ])
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs> & { isWorktreeActive: boolean }) =>
        useTerminalTabColdParking(args),
      {
        initialProps: {
          ...hookArgs(false),
          assignments,
          isWorktreeActive: true,
          activeTerminalTabId: 'tab-2'
        }
      }
    )
    expect(result.current.size).toBe(0)

    act(() => {
      rerender({
        ...hookArgs(false),
        assignments,
        isWorktreeActive: false,
        activeTerminalTabId: 'tab-2'
      })
    })
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })

    expect(result.current).toEqual(new Set(['tab-1']))
  })

  it('records focused split changes when the visible tab set does not change', () => {
    const assignments = new Map([
      ['tab-1', { groupId: 'group-1', isActiveInGroup: true }],
      ['tab-2', { groupId: 'group-2', isActiveInGroup: true }]
    ])
    const { result, rerender } = renderHook(
      (
        args: ReturnType<typeof hookArgs> & {
          activeTerminalTabId: string | null
          isWorktreeActive: boolean
        }
      ) => useTerminalTabColdParking(args),
      {
        initialProps: {
          ...hookArgs(false),
          assignments,
          isWorktreeActive: true,
          activeTerminalTabId: 'tab-1'
        }
      }
    )

    act(() => {
      rerender({
        ...hookArgs(false),
        assignments,
        isWorktreeActive: true,
        activeTerminalTabId: 'tab-2'
      })
    })
    act(() => {
      rerender({
        ...hookArgs(false),
        assignments,
        isWorktreeActive: false,
        activeTerminalTabId: 'tab-2'
      })
    })
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })

    expect(result.current).toEqual(new Set(['tab-1']))
  })

  // After damping, expired hysteresis leaves pin expiry as the only wakeup; missing it retains the pane indefinitely.
  it('re-parks a damped tab once the pin expires with no other store change', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    // Freeze time so every coverage flip lands within the damping burst window.
    for (let flip = 0; flip <= TERMINAL_TAB_PARK_FLIP_BURST_LIMIT + 1; flip += 1) {
      mocks.watcherCoverage = flip % 2 === 1
      act(() => {
        rerender(hookArgs(false))
      })
    }
    mocks.watcherCoverage = true
    act(() => {
      rerender(hookArgs(false))
    })
    expect(result.current.size).toBe(0)

    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Preserve hiddenSince through measurement, then grant cooldown to prevent immediate re-park.
  it('preserves tab hiddenSince through a measure window and re-parks only after the cool-down', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )
    expect(result.current.size).toBe(0)

    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    act(() => {
      rerender(hookArgs(true))
    })
    expect(result.current.size).toBe(0)
    act(() => {
      vi.advanceTimersByTime(3_000)
      rerender(hookArgs(false))
    })

    expect(result.current.size).toBe(0)
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_COLD_PARK_DELAY_MS - 1)
    })
    expect(result.current.size).toBe(0)

    // Re-parking after cooldown proves measurement preserved the hidden clock instead of restarting hot retention.
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  it('temporarily unparks only the exact target of a queued runtime split', () => {
    const args = { ...hookArgs(false), coldParkTerminalPanes: true }
    const { result } = renderHook(() => useTerminalTabColdParking(args))
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    act(() => {
      queueTerminalPaneSplitRequest({
        tabId: 'tab-2',
        paneRuntimeId: 9,
        direction: 'vertical'
      })
    })
    expect(result.current).toEqual(new Set(['tab-1']))

    act(() => {
      vi.advanceTimersByTime(BACKGROUND_WORKTREE_MEASURE_WINDOW_MS)
    })
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))
  })

  // Visible worktrees end measurement without owing hidden tabs a cooldown.
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

    act(() => {
      vi.advanceTimersByTime(3_000)
      rerender({ ...hookArgs(false), isWorktreeActive: true })
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Splits update layout PTYs without changing terminalTabs; that must invalidate exemption memoization.
  it('re-resolves exemptions when only the layout PTYs change', () => {
    const stableArgs = { ...hookArgs(false), coldParkTerminalPanes: true, isForceParked: true }
    const { result, rerender } = renderHook(
      (args: typeof stableArgs) => useTerminalTabColdParking(args),
      { initialProps: stableArgs }
    )
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    mocks.exemptTabIds = new Set(['tab-1'])
    act(() => {
      rerender(stableArgs)
    })
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    mocks.storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { 'leaf-2': 'pty-local-detached' } }
    }
    act(() => {
      invalidateTerminalParkingInputs(WORKTREE_ID)
      rerender(stableArgs)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Per-tab parking would strand a sleeping agent’s cold restore until reveal.
  it('unparks a per-tab-parked pane once it owns a sleeping-session record', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )

    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    mocks.storeState.sleepingAgentSessionsByPaneKey = {
      'tab-2:22222222-2222-4222-8222-222222222222': {
        paneKey: 'tab-2:22222222-2222-4222-8222-222222222222',
        tabId: 'tab-2',
        worktreeId: WORKTREE_ID
      }
    }
    act(() => {
      // Advance fake time so ordinary rerenders do not appear as burst oscillation.
      vi.advanceTimersByTime(TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS)
      rerender(hookArgs(false))
    })
    expect(result.current.size).toBe(0)

    mocks.storeState.sleepingAgentSessionsByPaneKey = {
      'tab-2:22222222-2222-4222-8222-222222222222': {
        paneKey: 'tab-2:22222222-2222-4222-8222-222222222222',
        tabId: 'tab-2',
        worktreeId: 'other-worktree'
      }
    }
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS)
      rerender(hookArgs(false))
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })

  // Passive-completed sessions never auto-resume and must not retain hidden panes indefinitely.
})
