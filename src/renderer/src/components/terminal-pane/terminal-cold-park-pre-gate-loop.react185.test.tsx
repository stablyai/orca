/** @vitest-environment happy-dom */
import { act, StrictMode } from 'react'
import type * as ReactModule from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  worktreeId: 'repo::/cold-park-pre-gate',
  discardMemoCaches: false,
  coverageCalls: 0,
  syncCalls: 0,
  slotRenders: 0,
  renderedParkedSets: [] as string[][]
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react')
  return {
    ...actual,
    useMemo: ((calculate, dependencies) =>
      harness.discardMemoCaches
        ? calculate()
        : actual.useMemo(calculate, dependencies)) as typeof actual.useMemo
  }
})

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    activeGroupIdByWorktree: {} as Record<string, string | undefined>,
    groupsByWorktree: {} as Record<string, TabGroup[]>,
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, TerminalTab[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    unifiedTabsByWorktree: {} as Record<string, Tab[]>,
    consumeSuppressedPtyExit: () => false,
    focusGroup: () => {},
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 2 }),
    setActiveWorktree: () => {}
  }))
  return { useAppStore }
})

vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))

vi.mock('./TerminalOverlaySlot', () => ({
  TerminalOverlaySlot: () => {
    harness.slotRenders += 1
    return null
  }
}))

vi.mock('./terminal-parked-tab-watchers', async () => {
  const { useAppStore } = await import('../../store')
  return {
    canWatcherCoverParkedTerminalTab: () => {
      harness.coverageCalls += 1
      return harness.coverageCalls % 2 === 1
    },
    disposeParkedTerminalWatchersForWorktree: () => {},
    syncParkedTerminalTabWatchers: (args: {
      worktreeId: string
      parkedTabIds: ReadonlySet<string>
    }) => {
      harness.syncCalls += 1
      harness.renderedParkedSets.push([...args.parkedTabIds].sort())
      if (args.parkedTabIds.size === 0) {
        return
      }
      ;(
        useAppStore as unknown as {
          setState: (update: (state: ParkingStoreState) => Partial<ParkingStoreState>) => void
        }
      ).setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [args.worktreeId]: state.tabsByWorktree[args.worktreeId].map((tab) => ({
            ...tab,
            title: `${tab.id}-${harness.syncCalls}`
          }))
        },
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [args.worktreeId]: state.unifiedTabsByWorktree[args.worktreeId].map((tab) => ({
            ...tab,
            label: `${tab.entityId}-${harness.syncCalls}`
          }))
        }
      }))
    }
  }
})

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({ coldParkDelayMs: 0, hotRetainMs: 0 })
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

import { useAppStore } from '../../store'
import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

const TAB_IDS = ['tab-a', 'tab-b'] as const
const GROUP_ID = 'group-a'

type ParkingStoreState = {
  groupsByWorktree: Record<string, TabGroup[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
}

const parkingStore = useAppStore as unknown as {
  getState: () => ParkingStoreState
  setState: (partial: Record<string, unknown>) => void
}

function terminalTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: harness.worktreeId,
    ptyId: `${harness.worktreeId}@@session-${id}`,
    title: id,
    generation: 0
  } as TerminalTab
}

function unifiedTerminalTab(id: string): Tab {
  return {
    id: `unified-${id}`,
    entityId: id,
    worktreeId: harness.worktreeId,
    groupId: GROUP_ID,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function renderProductionLayer(root: Root, coldParkTerminalPanes = true): unknown {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  let thrown: unknown = null
  try {
    act(() => {
      root.render(
        <StrictMode>
          <TerminalPaneOverlayLayer
            worktreeId={harness.worktreeId}
            worktreePath="cold-park-pre-gate"
            isWorktreeActive={false}
            coldParkTerminalPanes={coldParkTerminalPanes}
          />
        </StrictMode>
      )
    })
  } catch (error) {
    thrown = error
  }
  consoleError.mockRestore()
  return thrown
}

describe('TerminalPaneOverlayLayer cold-park pre-gate loop', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    harness.discardMemoCaches = false
    harness.coverageCalls = 0
    harness.syncCalls = 0
    harness.slotRenders = 0
    harness.renderedParkedSets.length = 0
    const tabs = TAB_IDS.map(terminalTab)
    const unifiedTabs = TAB_IDS.map(unifiedTerminalTab)
    parkingStore.setState({
      activeGroupIdByWorktree: { [harness.worktreeId]: GROUP_ID },
      groupsByWorktree: {
        [harness.worktreeId]: [
          {
            id: GROUP_ID,
            worktreeId: harness.worktreeId,
            activeTabId: unifiedTabs[0].id,
            tabOrder: unifiedTabs.map((tab) => tab.id),
            recentTabIds: [unifiedTabs[0].id]
          }
        ]
      },
      tabsByWorktree: { [harness.worktreeId]: tabs },
      unifiedTabsByWorktree: { [harness.worktreeId]: unifiedTabs }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    try {
      act(() => root?.unmount())
    } catch {
      // A failed initial commit leaves no mounted tree to clean up.
    }
    root = undefined
    container.remove()
  })

  it('settles title publications without suppressing PTY rechecks', () => {
    root = createRoot(container)
    const thrown = renderProductionLayer(root)

    expect(thrown).toBeNull()
    expect(harness.coverageCalls).toBe(2)
    expect(harness.syncCalls).toBeLessThan(10)
    expect(harness.renderedParkedSets).not.toHaveLength(0)
    expect(new Set(harness.renderedParkedSets.map((ids) => ids.join(',')))).toEqual(
      new Set([TAB_IDS.join(',')])
    )
    expect(harness.slotRenders).toBe(0)

    const settledSyncCalls = harness.syncCalls
    const state = parkingStore.getState()
    act(() => {
      parkingStore.setState({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [harness.worktreeId]: state.tabsByWorktree[harness.worktreeId].map((tab) =>
            tab.id === TAB_IDS[1] ? { ...tab, ptyId: `${tab.ptyId}-replacement` } : tab
          )
        }
      })
    })

    expect(harness.coverageCalls).toBe(3)
    expect(harness.syncCalls).toBeGreaterThan(settledSyncCalls)
    expect(new Set(harness.renderedParkedSets.map((ids) => ids.join(',')))).toEqual(
      new Set([TAB_IDS.join(',')])
    )
    expect(harness.slotRenders).toBe(0)

    const beforePendingSpawnSyncCalls = harness.syncCalls
    const pendingSpawnState = parkingStore.getState()
    act(() => {
      parkingStore.setState({
        tabsByWorktree: {
          ...pendingSpawnState.tabsByWorktree,
          [harness.worktreeId]: pendingSpawnState.tabsByWorktree[harness.worktreeId].map((tab) =>
            tab.id === TAB_IDS[1] ? { ...tab, pendingActivationSpawn: 1 } : tab
          )
        }
      })
    })
    expect(harness.syncCalls).toBeGreaterThan(beforePendingSpawnSyncCalls)

    const beforeTabOrderSyncCalls = harness.syncCalls
    const tabOrderState = parkingStore.getState()
    act(() => {
      parkingStore.setState({
        tabsByWorktree: {
          ...tabOrderState.tabsByWorktree,
          [harness.worktreeId]: tabOrderState.tabsByWorktree[harness.worktreeId].toReversed()
        }
      })
    })
    expect(harness.syncCalls).toBeGreaterThan(beforeTabOrderSyncCalls)

    const beforeActiveTabChangeSyncCalls = harness.syncCalls
    const activeTabState = parkingStore.getState()
    act(() => {
      parkingStore.setState({
        groupsByWorktree: {
          ...activeTabState.groupsByWorktree,
          [harness.worktreeId]: activeTabState.groupsByWorktree[harness.worktreeId].map(
            (group) => ({
              ...group,
              activeTabId: `unified-${TAB_IDS[1]}`
            })
          )
        }
      })
    })
    expect(harness.syncCalls).toBeGreaterThan(beforeActiveTabChangeSyncCalls)

    const beforeGroupChangeSyncCalls = harness.syncCalls
    const groupState = parkingStore.getState()
    const nextGroupId = 'group-b'
    act(() => {
      parkingStore.setState({
        groupsByWorktree: {
          ...groupState.groupsByWorktree,
          [harness.worktreeId]: [
            ...groupState.groupsByWorktree[harness.worktreeId],
            {
              id: nextGroupId,
              worktreeId: harness.worktreeId,
              activeTabId: `unified-${TAB_IDS[1]}`,
              tabOrder: [`unified-${TAB_IDS[1]}`],
              recentTabIds: [`unified-${TAB_IDS[1]}`]
            }
          ]
        },
        unifiedTabsByWorktree: {
          ...groupState.unifiedTabsByWorktree,
          [harness.worktreeId]: groupState.unifiedTabsByWorktree[harness.worktreeId].map((tab) =>
            tab.entityId === TAB_IDS[1] ? { ...tab, groupId: nextGroupId } : tab
          )
        }
      })
    })
    expect(harness.syncCalls).toBeGreaterThan(beforeGroupChangeSyncCalls)

    expect(renderProductionLayer(root, false)).toBeNull()
    expect(harness.slotRenders).toBeGreaterThan(0)

    expect(renderProductionLayer(root)).toBeNull()
    expect(harness.renderedParkedSets.at(-1)).toEqual([...TAB_IDS])
  })

  it('settles equivalent publications after memo cache discard', () => {
    harness.discardMemoCaches = true
    root = createRoot(container)

    const thrown = renderProductionLayer(root)

    expect(thrown).toBeNull()
    expect(harness.syncCalls).toBeLessThan(10)
    expect(new Set(harness.renderedParkedSets.map((ids) => ids.join(',')))).toEqual(
      new Set([TAB_IDS.join(',')])
    )
  })
})
