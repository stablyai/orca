/** @vitest-environment happy-dom */
/**
 * Park-verdict oscillation driven by an input the cold-park selector never sees.
 *
 * Why this shape (issue #15136): Terminal.tsx vetoes a WORKTREE park with
 * worktreeTabsAreWatcherCovered → canWatcherCoverParkedTerminalTab, which a
 * mounted pane grants and a parked pane withdraws. That verdict arrives here as
 * the coldParkTerminalPanes prop, which short-circuits the cold-park branch of
 * the rendered verdict — so withholdUnparkableTerminalTabs, which only filters
 * the cold-park candidate list, can never damp it.
 *
 * The single tab is deliberate: selectIdsBeyondHotRetain spares the lone
 * most-recently-hidden candidate, so the cold-park set stays empty and
 * coldParkTerminalPanes is provably the only driver of the rendered verdict.
 *
 * Field signature this reproduces: one tab, `trigger: burst` crumbs recurring
 * 60 008 / 60 020 / 60 012 ms apart (the pin window), i.e. flips continuing at
 * commit cadence underneath a live pin instead of stopping.
 */
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const park = vi.hoisted(() => ({ worktreeId: 'repo::/wt-worktree-driver' }))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    settings: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    runtimePaneTitlesByTabId: {} as Record<string, unknown>,
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

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({ coldParkDelayMs: 0, hotRetainMs: 0 })
}))

import { useAppStore } from '../../store'
import { TERMINAL_TAB_PARK_FLIP_BURST_LIMIT } from './terminal-park-verdict-flip-telemetry'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const TAB_ID = 'tab-worktree-driven'
/** Stops an unfixed loop from hanging the run if React ever raises its bail. */
const RENDER_HARD_STOP = 400
/** +1: the pin lands in the passive effect observing the burst flip. */
const SETTLED_FLIP_BUDGET = TERMINAL_TAB_PARK_FLIP_BURST_LIMIT + 1
const EMPTY_ASSIGNMENTS = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
const EMPTY_PORTALS: never[] = []

type ParkingStoreState = { tabsByWorktree: Record<string, TerminalTab[]> }

const parkingStore = useAppStore as unknown as {
  setState: (partial: (state: ParkingStoreState) => Partial<ParkingStoreState>) => void
}

let hostRenderCount = 0
let parkVerdictFlipCount = 0
let lastParkVerdict = false
let paneMountCount = 0

/** The pane whose mount/unmount the park verdict authorizes. */
function TerminalPaneStandIn(): null {
  useEffect(() => {
    paneMountCount += 1
  }, [])
  return null
}

/**
 * Terminal.tsx's worktree-level verdict, modelled: a mounted pane grants the
 * byte-watcher coverage the worktree park requires, and a parked pane withdraws
 * it. Runs in a passive effect, so each turn of the loop costs one commit.
 */
function WorktreeParkVerdict({
  parked,
  onVerdict
}: {
  parked: boolean
  onVerdict: (coldParkTerminalPanes: boolean) => void
}): null {
  useEffect(() => {
    onVerdict(!parked)
  }, [parked, onVerdict])
  return null
}

function OverlayHost(): React.JSX.Element | null {
  hostRenderCount += 1
  const [coldParkTerminalPanes, setColdParkTerminalPanes] = useState(false)
  const terminalTabs = useAppStore(
    (state) => (state as ParkingStoreState).tabsByWorktree[park.worktreeId]
  ) as TerminalTab[]
  const parkedTerminalTabIds = useTerminalTabColdParking({
    worktreeId: park.worktreeId,
    terminalTabs,
    assignments: EMPTY_ASSIGNMENTS,
    isWorktreeActive: false,
    activeTerminalTabId: null,
    coldParkTerminalPanes,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: EMPTY_PORTALS,
    activationDeferredMountTabIds: null
  })
  const parked = parkedTerminalTabIds.has(TAB_ID)
  if (parked !== lastParkVerdict) {
    parkVerdictFlipCount += 1
  }
  lastParkVerdict = parked
  if (hostRenderCount > RENDER_HARD_STOP) {
    return null
  }
  return (
    <>
      {parked ? null : <TerminalPaneStandIn />}
      <WorktreeParkVerdict parked={parked} onVerdict={setColdParkTerminalPanes} />
    </>
  )
}

function renderOverlayHost(root: Root): unknown {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  let thrown: unknown = null
  try {
    act(() => {
      root.render(<OverlayHost />)
    })
  } catch (error) {
    thrown = error
  }
  consoleError.mockRestore()
  return thrown
}

describe('park-verdict damping reaches the worktree-level driver', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    hostRenderCount = 0
    parkVerdictFlipCount = 0
    lastParkVerdict = false
    paneMountCount = 0
    parkingStore.setState(() => ({
      tabsByWorktree: {
        [park.worktreeId]: [
          { id: TAB_ID, ptyId: `${park.worktreeId}@@session-1`, title: TAB_ID } as TerminalTab
        ]
      }
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = undefined
    container.remove()
  })

  it('settles a verdict whose only driver is the worktree-level park prop', () => {
    root = createRoot(container)
    const thrown = renderOverlayHost(root)

    expect(thrown).toBeNull()
    // Without damping on the rendered verdict this runs to RENDER_HARD_STOP:
    // the burst pin only subtracts from the cold-park candidate set, which is
    // empty here, so it silences its breadcrumb and damps nothing.
    expect(parkVerdictFlipCount).toBeLessThanOrEqual(SETTLED_FLIP_BUDGET)
    // Settles on the safe side: the pane stays mounted, so bells/titles/
    // completions never go silent behind a wedged verdict.
    expect(lastParkVerdict).toBe(false)
    // Measured: 4 flips / 3 mounts / 6 renders with damping, against
    // 400 flips / 200 mounts before it — the pre-fix run only stops because
    // RENDER_HARD_STOP stops it.
    expect(paneMountCount).toBeGreaterThan(0)
    expect(paneMountCount).toBeLessThanOrEqual(SETTLED_FLIP_BUDGET)
    expect(hostRenderCount).toBeLessThan(RENDER_HARD_STOP)
  })
})
