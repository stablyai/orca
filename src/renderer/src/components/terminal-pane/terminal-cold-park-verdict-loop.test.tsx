/** @vitest-environment happy-dom */
/**
 * Cold-park verdict oscillation (crash cluster: React #185 in the terminal overlay).
 *
 * Why this shape: canWatcherCoverParkedTerminalTab is re-derived from store and
 * registry state that mounting/unmounting the very pane the verdict controls
 * rewrites, and the parked watchers write the tab model back. The pane stand-in
 * models that edge — mounted pane grants coverage, parked pane withdraws it,
 * and either transition re-mints the tab array the cold-park effect depends on.
 *
 * Why the store-write chain is parameterised: React bails on *commits*, not on
 * flips, so a damping threshold expressed in flips is only safe if it holds at
 * the real cycle's commits-per-flip cost (pane-connect updateTabPtyId, the
 * watcher-sync writes, the overlay's own subscriber renders). The chain models
 * that cost so the derived burst limit stays regression-tested.
 */
import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const park = vi.hoisted(() => ({
  worktreeId: 'repo::/wt-park-loop',
  /** Whether the byte watchers could cover the tab if it parked right now. */
  coverage: true
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
    tabsByWorktree: {} as Record<string, TerminalTab[]>
  }))
  return { useAppStore }
})

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => park.coverage,
  disposeParkedTerminalWatchersForWorktree: () => {},
  resolveParkedTerminalPaneCandidates: () => [],
  syncParkedTerminalTabWatchers: () => {}
}))

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({ coldParkDelayMs: 0, hotRetainMs: 0 })
}))

import { useAppStore } from '../../store'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_COMMIT_COST
} from './terminal-park-verdict-flip-telemetry'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

/** The most recently hidden tab holds the last-active retain exemption. */
const EXEMPT_TAB_ID = 'tab-a'
const PARKABLE_TAB_ID = 'tab-b'
/** Stops an unfixed loop from hanging the run if React ever raises its bail. */
const RENDER_HARD_STOP = 500
/** +1: the pin lands in the passive effect observing the burst flip, so the
 *  verdict settles one flip after damping engages. */
const SETTLED_FLIP_BUDGET = TERMINAL_TAB_PARK_FLIP_BURST_LIMIT + 1
const EMPTY_ASSIGNMENTS = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
const EMPTY_PORTALS: never[] = []

type ParkingStoreState = { tabsByWorktree: Record<string, TerminalTab[]> }

const parkingStore = useAppStore as unknown as {
  setState: (partial: (state: ParkingStoreState) => Partial<ParkingStoreState>) => void
}

function terminalTab(id: string): TerminalTab {
  return { id, ptyId: `${park.worktreeId}@@session-${id}`, title: id } as TerminalTab
}

let tabModelRevision = 0

// Models the store writes a pane mount/unmount produces — updateTabPtyId on
// connect, parked-watcher title writes — both of which re-mint the tab array.
function rewriteTabModel(tabId: string): void {
  tabModelRevision += 1
  const revision = tabModelRevision
  parkingStore.setState((state) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [park.worktreeId]: (state.tabsByWorktree[park.worktreeId] ?? []).map((tab) =>
        tab.id === tabId ? { ...tab, title: `${tab.id}-${revision}` } : tab
      )
    }
  }))
}

/** Store writes a single park transition costs; each lands in its own commit. */
let storeCommitsPerParkTransition = 1
let paneMountCount = 0

/** The pane whose mount/unmount the park verdict authorizes. */
function TerminalPaneStandIn(): null {
  useEffect(() => {
    paneMountCount += 1
  }, [])
  return null
}

/**
 * The store writes a park transition drags behind it — pane-connect
 * updateTabPtyId, then the watcher-sync writes that each only see the tab model
 * the previous write produced. Coverage is re-derived from the last of them, so
 * the verdict cannot flip until the whole chain has committed. Why staged
 * rather than batched: nested commits are what React counts against
 * NESTED_UPDATE_LIMIT, so this is the per-flip cost the damping must beat.
 */
function ParkTransitionStoreWrites({ parked }: { parked: boolean }): null {
  const pendingWritesRef = useRef(storeCommitsPerParkTransition)
  const lastParkedRef = useRef(parked)
  const [writeTick, setWriteTick] = useState(0)
  useEffect(() => {
    if (lastParkedRef.current !== parked) {
      lastParkedRef.current = parked
      pendingWritesRef.current = storeCommitsPerParkTransition
    }
    if (pendingWritesRef.current <= 0) {
      return
    }
    pendingWritesRef.current -= 1
    if (pendingWritesRef.current === 0) {
      // A mounted pane grants byte-watcher coverage; a parked one withdraws it.
      park.coverage = !parked
    }
    rewriteTabModel(PARKABLE_TAB_ID)
    setWriteTick((tick) => tick + 1)
  }, [parked, writeTick])
  return null
}

let hostRenderCount = 0
let parkVerdictFlipCount = 0
let lastParkVerdict = false

function OverlayHost(): React.JSX.Element | null {
  hostRenderCount += 1
  const terminalTabs = useAppStore(
    (state) => (state as ParkingStoreState).tabsByWorktree[park.worktreeId]
  ) as TerminalTab[]
  const parkedTerminalTabIds = useTerminalTabColdParking({
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
  const parked = parkedTerminalTabIds.has(PARKABLE_TAB_ID)
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
      <ParkTransitionStoreWrites parked={parked} />
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

describe('cold-park verdict oscillation', () => {
  let container: HTMLDivElement
  // Why optional: a throwing createRoot must not be masked by an afterEach TypeError.
  let root: Root | undefined

  beforeEach(() => {
    park.coverage = true
    hostRenderCount = 0
    parkVerdictFlipCount = 0
    lastParkVerdict = false
    tabModelRevision = 0
    paneMountCount = 0
    storeCommitsPerParkTransition = 1
    parkingStore.setState(() => ({
      tabsByWorktree: {
        [park.worktreeId]: [terminalTab(EXEMPT_TAB_ID), terminalTab(PARKABLE_TAB_ID)]
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

  it('settles the park verdict when watcher coverage tracks the pane it unmounts', () => {
    root = createRoot(container)
    const thrown = renderOverlayHost(root)

    // Damping must land inside the burst window and settle on the safe side:
    // the pane stays mounted, so bells/titles/completions never go silent.
    expect(thrown).toBeNull()
    expect(parkVerdictFlipCount).toBeLessThanOrEqual(SETTLED_FLIP_BUDGET)
    expect(lastParkVerdict).toBe(false)
    expect(paneMountCount).toBeGreaterThan(0)
  })

  // Why: the burst limit is derived from React's 50-commit bail divided by an
  // assumed worst-case commits-per-flip. Running the loop at exactly that cost
  // is what keeps the derivation honest — a limit tuned on a one-write-per-flip
  // model pins only after React has already thrown #185.
  it('settles at the assumed worst-case commit cost per park transition', () => {
    storeCommitsPerParkTransition = TERMINAL_TAB_PARK_FLIP_COMMIT_COST
    root = createRoot(container)
    const thrown = renderOverlayHost(root)

    expect(thrown).toBeNull()
    expect(parkVerdictFlipCount).toBeLessThanOrEqual(SETTLED_FLIP_BUDGET)
    expect(lastParkVerdict).toBe(false)
    expect(paneMountCount).toBeGreaterThan(0)
  })
})
