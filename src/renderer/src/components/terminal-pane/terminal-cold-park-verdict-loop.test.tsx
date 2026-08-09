/** @vitest-environment happy-dom */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const park = vi.hoisted(() => ({
  worktreeId: 'repo::/wt-park-loop',
  materialRevision: 0,
  captureSource: 'fallback' as 'fallback' | 'capture',
  failNextHandoff: false,
  syncedParked: new Set<string>(),
  observedSources: [] as string[]
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    pendingStartupByTabId: {} as Record<string, unknown>,
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
  disposeParkedTerminalWatchersForWorktree: () => {},
  planParkedTerminalTabWatcherCoverage: (worktreeId: string, tab: TerminalTab) => {
    park.observedSources.push(park.captureSource)
    return {
      status: 'covered',
      materialKey: `${worktreeId}:${tab.id}:${tab.ptyId}:${park.materialRevision}`,
      worktreeId,
      tabId: tab.id,
      tabPtyId: tab.ptyId,
      generation: tab.generation ?? null,
      panes: [
        {
          leafId: '11111111-1111-4111-8111-111111111111',
          ptyId: tab.ptyId
        }
      ]
    }
  },
  subscribeParkedTerminalWatcherOwnershipLoss: () => () => {},
  syncParkedTerminalTabWatchersWithAcknowledgements: (args: {
    parkedTabIds: ReadonlySet<string>
    forcedTabIds: ReadonlySet<string>
    coveragePlansByTabId: ReadonlyMap<
      string,
      { materialKey: string; panes: readonly { ptyId: string | null }[] }
    >
  }) => {
    const acknowledgements: object[] = []
    for (const tabId of args.parkedTabIds) {
      const plan = args.coveragePlansByTabId.get(tabId)
      const watchedPtyIds = (plan?.panes ?? []).flatMap((pane) =>
        pane.ptyId === null ? [] : [pane.ptyId]
      )
      if (!park.syncedParked.has(tabId)) {
        park.syncedParked.add(tabId)
        rewriteTabModel(tabId)
      }
      if (args.forcedTabIds.has(tabId)) {
        acknowledgements.push({
          status: 'forced',
          tabId,
          materialKey: plan?.materialKey ?? null,
          watchedPtyIds
        })
      } else if (park.failNextHandoff && tabId === PARKABLE_TAB_ID) {
        park.failNextHandoff = false
        acknowledgements.push({
          status: 'failed',
          tabId,
          materialKey: plan?.materialKey ?? null,
          reason: 'watcher-coverage-incomplete',
          expectedPtyIds: watchedPtyIds,
          watchedPtyIds: []
        })
      } else {
        acknowledgements.push({
          status: 'covering',
          tabId,
          materialKey: plan?.materialKey ?? '',
          watchedPtyIds
        })
      }
    }
    for (const tabId of park.syncedParked) {
      if (!args.parkedTabIds.has(tabId)) {
        park.syncedParked.delete(tabId)
      }
    }
    return acknowledgements
  }
}))

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({ coldParkDelayMs: 0, hotRetainMs: 0 })
}))

import { useAppStore } from '../../store'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const EXEMPT_TAB_ID = 'tab-a'
const PARKABLE_TAB_ID = 'tab-b'
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

function rewriteTabModel(tabId: string): void {
  tabModelRevision += 1
  parkingStore.setState((state) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [park.worktreeId]: (state.tabsByWorktree[park.worktreeId] ?? []).map((tab) =>
        tab.id === tabId ? { ...tab, title: `${tab.id}-${tabModelRevision}` } : tab
      )
    }
  }))
}

let paneMountCount = 0

function TerminalPaneStandIn(): null {
  useEffect(() => {
    paneMountCount += 1
    park.captureSource = 'fallback'
    return () => {
      park.captureSource = 'capture'
    }
  }, [])
  return null
}

let worktreeParkRequested = false
let shouldMeasureHiddenWorktree = false
let parkVerdictFlipCount = 0
let lastParkVerdict = false

function OverlayHost(): React.JSX.Element | null {
  const terminalTabs = useAppStore(
    (state) => (state as ParkingStoreState).tabsByWorktree[park.worktreeId]
  ) as TerminalTab[]
  const parkedTerminalTabIds = useTerminalTabColdParking({
    worktreeId: park.worktreeId,
    terminalTabs,
    assignments: EMPTY_ASSIGNMENTS,
    isWorktreeActive: false,
    coldParkTerminalPanes: worktreeParkRequested,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals: EMPTY_PORTALS,
    activationDeferredMountTabIds: null
  })
  const parked = parkedTerminalTabIds.has(PARKABLE_TAB_ID)
  if (parked !== lastParkVerdict) {
    parkVerdictFlipCount += 1
  }
  lastParkVerdict = parked
  return parked ? null : <TerminalPaneStandIn />
}

function renderOverlayHost(root: Root): unknown {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  let thrown: unknown = null
  try {
    act(() => root.render(<OverlayHost />))
  } catch (error) {
    thrown = error
  }
  consoleError.mockRestore()
  return thrown
}

describe('cold-park episode stability', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    park.materialRevision = 0
    park.captureSource = 'fallback'
    park.failNextHandoff = false
    park.syncedParked.clear()
    park.observedSources.length = 0
    tabModelRevision = 0
    paneMountCount = 0
    worktreeParkRequested = false
    shouldMeasureHiddenWorktree = false
    parkVerdictFlipCount = 0
    lastParkVerdict = false
    parkingStore.setState(() => ({
      tabsByWorktree: {
        [park.worktreeId]: [terminalTab(EXEMPT_TAB_ID), terminalTab(PARKABLE_TAB_ID)]
      }
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container.remove()
  })

  it('keeps one verdict across title writes and capture-source changes', () => {
    root = createRoot(container)

    expect(renderOverlayHost(root)).toBeNull()
    expect(lastParkVerdict).toBe(true)
    expect(parkVerdictFlipCount).toBe(1)
    expect(paneMountCount).toBe(1)
    expect(new Set(park.observedSources)).toEqual(new Set(['fallback', 'capture']))
  })

  it('remounts once after a failed worktree handoff and re-arms on a new plan', () => {
    shouldMeasureHiddenWorktree = true
    root = createRoot(container)
    expect(renderOverlayHost(root)).toBeNull()
    expect(paneMountCount).toBe(1)

    shouldMeasureHiddenWorktree = false
    worktreeParkRequested = true
    park.failNextHandoff = true
    expect(renderOverlayHost(root)).toBeNull()
    expect(lastParkVerdict).toBe(false)
    expect(parkVerdictFlipCount).toBe(2)
    expect(paneMountCount).toBe(2)

    act(() => {
      for (let revision = 0; revision < 20; revision += 1) {
        rewriteTabModel(PARKABLE_TAB_ID)
      }
    })
    expect(lastParkVerdict).toBe(false)
    expect(paneMountCount).toBe(2)

    park.materialRevision += 1
    act(() => rewriteTabModel(PARKABLE_TAB_ID))
    expect(lastParkVerdict).toBe(true)
    expect(parkVerdictFlipCount).toBe(3)
  })
})
