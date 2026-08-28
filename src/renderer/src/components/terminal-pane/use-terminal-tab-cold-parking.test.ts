// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { selectColdParkedTerminalTabs } from './terminal-hidden-view-parking'

const mocks = vi.hoisted(() => ({
  storeState: {
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, { ptyIdsByLeafId?: Record<string, string> }>,
    sleepingAgentSessionsByPaneKey: {} as Record<
      string,
      { paneKey: string; tabId?: string; worktreeId: string }
    >
  },
  exemptTabIds: new Set<string>(),
  exemptSelectCalls: 0,
  coldParkSelectCalls: 0,
  /** Toggled to churn the park verdict the way the crash cluster does. */
  watcherCoverage: true
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState)
}))

vi.mock('./terminal-hidden-view-parking', async (importOriginal) => {
  const actual = await importOriginal<{
    selectColdParkedTerminalTabs: typeof selectColdParkedTerminalTabs
  }>()
  return {
    ...actual,
    selectColdParkedTerminalTabs: (
      args: Parameters<typeof actual.selectColdParkedTerminalTabs>[0]
    ) => {
      mocks.coldParkSelectCalls += 1
      return actual.selectColdParkedTerminalTabs(args)
    }
  }
})

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
  canWatcherCoverParkedTerminalTab: () => mocks.watcherCoverage,
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  syncParkedTerminalTabWatchers: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
  TERMINAL_TAB_PARK_FLIP_WINDOW_MS
} from './terminal-park-verdict-flip-telemetry'
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
    mocks.coldParkSelectCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    mocks.exemptTabIds = new Set()
    mocks.exemptSelectCalls = 0
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

  it('parks paired-runtime tabs only when their exact host advertises restore', () => {
    const environmentId = 'paired-env'
    const remoteArgs = {
      ...hookArgs(false),
      terminalTabs: [
        { ...terminalTab('tab-1'), ptyId: `remote:${environmentId}@@term-1` },
        { ...terminalTab('tab-2'), ptyId: `remote:${environmentId}@@term-2` }
      ]
    }
    for (const [advertisedEnvironmentId, expected] of [
      [environmentId, new Set(['tab-2'])],
      ['other-env', new Set()]
    ] as const) {
      mocks.storeState.runtimeStatusByEnvironmentId = new Map([
        [advertisedEnvironmentId, { status: { capabilities: ['terminal.paired-parking.v1'] } }]
      ])
      const { result, unmount } = renderHook(() => useTerminalTabColdParking(remoteArgs))

      act(() => {
        vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
      })

      expect(result.current).toEqual(expected)
      unmount()
    }
  })

  it('skips parking scans for capability-equivalent status writes and scans membership changes', () => {
    const args = hookArgs(false)
    mocks.storeState.runtimeStatusByEnvironmentId = new Map([
      ['runtime-a', { status: { capabilities: ['terminal.multiplex.v1'], runtimeId: 'peer-a' } }]
    ])
    const { rerender } = renderHook(
      (props: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(props),
      { initialProps: args }
    )
    const initialSelectCalls = mocks.coldParkSelectCalls

    mocks.storeState.runtimeStatusByEnvironmentId = new Map([
      [
        'runtime-a',
        {
          status: {
            capabilities: ['terminal.multiplex.v1'],
            runtimeId: 'peer-a-reconnected',
            appVersion: '1.5.0'
          }
        }
      ]
    ])
    act(() => {
      rerender(args)
    })
    expect(mocks.coldParkSelectCalls).toBe(initialSelectCalls)

    mocks.storeState.runtimeStatusByEnvironmentId = new Map([
      [
        'runtime-a',
        {
          status: {
            capabilities: ['terminal.multiplex.v1', 'terminal.paired-parking.v1'],
            runtimeId: 'peer-a-reconnected'
          }
        }
      ]
    ])
    act(() => {
      rerender(args)
    })
    expect(mocks.coldParkSelectCalls).toBe(initialSelectCalls + 1)
  })

  // Why: the flip-damping pin removes the tab from the parked set, and every
  // hysteresis deadline of a long-hidden tab is already past — so the pin
  // deadline is the only wakeup that can ever re-park it. Without scheduling
  // it, damping silently becomes a permanent unpark: the pane (~4-5MB) stays
  // mounted for the life of the window, which is the renderer-OOM cluster.
  it('re-parks a damped tab once the pin expires with no other store change', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    // Churn the coverage veto at render cadence — no clock advance, so every
    // flip lands inside the burst window and damping engages.
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

  // Why: a parked pane can never cold-restore, so a per-tab park holding a
  // sleeping-session record would strand the agent's resume until tab reveal.
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
      // Why the clock advance: the verdict-flip burst limit is expressed per
      // second, and fake timers freeze Date.now(), so back-to-back rerenders
      // would read as an oscillation the damping is supposed to pin.
      vi.advanceTimersByTime(TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS)
      rerender(hookArgs(false))
    })
    expect(result.current.size).toBe(0)

    // Records for other worktrees change nothing.
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

  // Why: blocked and passive-completed records never auto-resume, so exempting
  // them would pin a hidden pane mounted indefinitely for nothing.
  it('keeps parking panes whose records cannot be consumed', () => {
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
        worktreeId: WORKTREE_ID,
        automaticResumeBlockedBy: 'legacy-orchestration-worker'
      } as never
    }
    act(() => {
      rerender(hookArgs(false))
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    mocks.storeState.sleepingAgentSessionsByPaneKey = {
      'tab-2:22222222-2222-4222-8222-222222222222': {
        paneKey: 'tab-2:22222222-2222-4222-8222-222222222222',
        tabId: 'tab-2',
        worktreeId: WORKTREE_ID,
        origin: 'worktree-sleep',
        state: 'done'
      } as never
    }
    act(() => {
      rerender(hookArgs(false))
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })
})
