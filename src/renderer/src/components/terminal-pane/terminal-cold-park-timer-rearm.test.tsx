/** @vitest-environment happy-dom */
/** Tab-model writes must recheck watcher coverage without rearming unchanged absolute deadlines; title floods must preserve the park instant and avoid timer churn. */
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const park = vi.hoisted(() => ({
  worktreeId: 'repo::/wt-park-timers',
  /** Counts cold-park effect runs; the effect reads the overrides exactly once. */
  effectRuns: 0
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    settings: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    runtimePaneTitlesByTabId: {} as Record<string, unknown>,
    sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, TerminalTab[]>
  }))
  return { useAppStore }
})

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeParkedTerminalWatchersForWorktree: () => {},
  resolveParkedTerminalPaneCandidates: () => [],
  syncParkedTerminalTabWatchers: () => {}
}))

/** A 60s hysteresis keeps every hidden tab holding a pending recheck timer. */
const COLD_PARK_DELAY_MS = 60_000

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => {
    park.effectRuns += 1
    return { coldParkDelayMs: 60_000, hotRetainMs: 60_000 }
  }
}))

import { useAppStore } from '../../store'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const TAB_IDS = ['tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e'] as const
const EMPTY_ASSIGNMENTS = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
const EMPTY_PORTALS: never[] = []
const TITLE_FLOOD_WRITES = 40
const TICK_MS = 10_000

type ParkingStoreState = { tabsByWorktree: Record<string, TerminalTab[]> }

const parkingStore = useAppStore as unknown as {
  setState: (partial: (state: ParkingStoreState) => Partial<ParkingStoreState>) => void
}

function terminalTab(id: string): TerminalTab {
  return { id, ptyId: `${park.worktreeId}@@session-${id}`, title: id } as TerminalTab
}

/** A runtime-title publication: re-mints tabsByWorktree, changes no park input. */
function publishTitle(revision: number): void {
  parkingStore.setState((state) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [park.worktreeId]: (state.tabsByWorktree[park.worktreeId] ?? []).map((tab) => ({
        ...tab,
        title: `${tab.id}-${revision}`
      }))
    }
  }))
}

let latestParkedTabIds: ReadonlySet<string> = new Set()

function ParkingHost({ writes }: { writes: number }): null {
  const terminalTabs = useAppStore(
    (state) => (state as ParkingStoreState).tabsByWorktree[park.worktreeId]
  ) as TerminalTab[]
  latestParkedTabIds = useTerminalTabColdParking({
    worktreeId: park.worktreeId,
    terminalTabs,
    assignments: EMPTY_ASSIGNMENTS,
    isWorktreeActive: false,
    activeTerminalTabId: null,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: EMPTY_PORTALS,
    activationDeferredMountTabIds: null
  })
  const [written, setWritten] = useState(0)
  useEffect(() => {
    if (written >= writes) {
      return
    }
    publishTitle(written)
    setWritten((current) => current + 1)
  }, [writes, written])
  return null
}

let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  park.effectRuns = 0
  latestParkedTabIds = new Set()
  parkingStore.setState(() => ({
    tabsByWorktree: { [park.worktreeId]: TAB_IDS.map(terminalTab) }
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Advances the clock in fixed ticks and reports the first tick that parks. */
function firstParkedElapsedMs(options: { publishTitles: boolean }): number {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  root = createRoot(container)
  act(() => root?.render(<ParkingHost writes={0} />))
  expect(latestParkedTabIds.size).toBe(0)

  for (let tick = 1; tick <= 12; tick += 1) {
    // advanceTimersByTime moves Date.now() and fires due timers together.
    act(() => vi.advanceTimersByTime(TICK_MS))
    // Both runs re-render every tick; only the flooded one publishes titles.
    act(() => root?.render(<ParkingHost writes={options.publishTitles ? tick : 0} />))
    if (latestParkedTabIds.size > 0) {
      return tick * TICK_MS
    }
  }
  throw new Error('never parked')
}

describe('cold-park recheck timers under a background title flood', () => {
  it('re-arms no park timer for tab-model writes that move no deadline', () => {
    root = createRoot(container)
    act(() => root?.render(<ParkingHost writes={0} />))

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    act(() => root?.render(<ParkingHost writes={TITLE_FLOOD_WRITES} />))

    // Per-write effect runs preserve watcher-coverage wakeups (terminal-cold-park-verdict-loop).
    expect(park.effectRuns).toBeGreaterThanOrEqual(TITLE_FLOOD_WRITES)
    expect(setTimeoutSpy.mock.calls.length).toBe(0)
    expect(clearTimeoutSpy.mock.calls.length).toBe(0)
  })

  it('parks at the same instant with and without a title flood', () => {
    const quiet = firstParkedElapsedMs({ publishTitles: false })
    act(() => root?.unmount())
    root = undefined
    vi.useRealTimers()
    park.effectRuns = 0
    latestParkedTabIds = new Set()
    parkingStore.setState(() => ({
      tabsByWorktree: { [park.worktreeId]: TAB_IDS.map(terminalTab) }
    }))

    const flooded = firstParkedElapsedMs({ publishTitles: true })

    expect(flooded).toBe(quiet)
    expect(quiet).toBe(COLD_PARK_DELAY_MS)
  })
})
