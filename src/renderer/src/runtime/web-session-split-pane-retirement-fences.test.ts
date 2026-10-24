import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import {
  isPtyBoundInAnotherTab,
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds,
  trackRetiredLeafIds,
  type RetiredPaneRemovals
} from '../components/terminal-pane/terminal-live-layout-reconciliation'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { beginPendingHostPaneMove } from './pending-host-pane-moves'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import {
  ENV,
  LEAF_ID,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

const TAB_ID = 'web-terminal-host-tab-1'
const mountedLeaves = [LEAF_ID, SECOND_LEAF_ID]

function snapshot(
  version: number,
  leaves = mountedLeaves,
  parentTabIdOf: (leafId: string) => string = () => 'host-tab-1'
): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    leaves.map((leafId) => ({
      type: 'terminal' as const,
      id: `${parentTabIdOf(leafId)}::${leafId}`,
      parentTabId: parentTabIdOf(leafId),
      leafId,
      title: 'shell',
      isActive: leafId === LEAF_ID,
      status: 'ready' as const,
      terminal: `terminal-${leafId}`
    })),
    { snapshotVersion: version }
  )
}

function retiredSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    ...snapshot(3, [LEAF_ID]),
    retiredTerminalSurfaces: [
      {
        parentTabId: 'host-tab-1',
        leafId: SECOND_LEAF_ID,
        terminal: `terminal-${SECOND_LEAF_ID}`,
        ptyId: 'native-second',
        incarnationId: 'inc-second'
      }
    ]
  }
}

function createReconciliation() {
  let state = makeState()
  let previousLayoutLeafIds: ReadonlySet<string> = new Set()
  let retiredLeafIds: ReadonlySet<string> = new Set()
  const mounted = new Set(mountedLeaves)
  const call = vi.fn(async () => {
    throw new Error('execution host unavailable')
  })

  function planRemovals(secondPtyId: string | null): RetiredPaneRemovals {
    const root = state.terminalLayoutsByTabId[TAB_ID]?.root
    expect(root).toBeDefined()
    const layoutLeafIds = new Set(root ? collectLeafIds(root) : [])
    retiredLeafIds = trackRetiredLeafIds({
      retiredLeafIds,
      previousLayoutLeafIds,
      layoutLeafIds,
      mountedLeafIds: mounted
    })
    previousLayoutLeafIds = layoutLeafIds
    return selectRetiredPaneIds(planTerminalLiveLayoutRemovals(root, mounted, retiredLeafIds), {
      paneCount: mounted.size,
      paneIdForLeaf: (leaf) => (leaf === LEAF_ID ? 1 : 2),
      ptyIdForPane: (pane) => (pane === 1 ? 'remote:first' : secondPtyId),
      isPtyBoundInAnotherTab: (ptyId) => isPtyBoundInAnotherTab(state, WT, TAB_ID, ptyId)
    })
  }

  return {
    call,
    plan: (secondPtyId: string | null): number[] => planRemovals(secondPtyId).closed,
    planRemovals,
    layoutOf: (tabId: string) => state.terminalLayoutsByTabId[tabId],
    /** This window's optimistic move of the second pane into a new tab, before the host has it. */
    moveSecondLocally(targetTabId: string) {
      const source = state.terminalLayoutsByTabId[TAB_ID]!
      const sourceTab = state.tabsByWorktree[WT]!.find((tab) => tab.id === TAB_ID)!
      const ptyId = source.ptyIdsByLeafId![SECOND_LEAF_ID]!
      state = {
        ...state,
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [WT]: [...state.tabsByWorktree[WT]!, { ...sourceTab, id: targetTabId, ptyId }]
        },
        terminalLayoutsByTabId: {
          ...state.terminalLayoutsByTabId,
          [TAB_ID]: {
            ...source,
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            ptyIdsByLeafId: { [LEAF_ID]: source.ptyIdsByLeafId![LEAF_ID]! }
          },
          [targetTabId]: {
            root: { type: 'leaf', leafId: SECOND_LEAF_ID },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [SECOND_LEAF_ID]: ptyId }
          }
        }
      }
    },
    removeSecond: () => mounted.delete(SECOND_LEAF_ID),
    leaves: () => collectLeafIds(state.terminalLayoutsByTabId[TAB_ID].root!),
    async receive(incoming: RuntimeMobileSessionTabsResult) {
      const recovered = await recoverWebSessionTerminalOrphansBeforeApply(state, incoming, ENV, {
        call
      })
      expect(recovered).not.toBeNull()
      if (recovered) {
        state = { ...state, ...applyFreshWebSessionTabsSnapshot(state, recovered, ENV) }
      }
    }
  }
}

describe('host snapshot fences before split-pane retirement', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  it('keeps a null-transport pane when an older layout arrives', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    expect(view.plan('remote:second')).toEqual([])
    await view.receive(retiredSnapshotWithVersion(1))
    expect(view.leaves()).toEqual(mountedLeaves)
    expect(view.plan(null)).toEqual([])
  })

  it('retains a missing pane when a newer layout cannot verify the host inventory', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan('remote:second')
    await view.receive(snapshot(3, [LEAF_ID]))
    expect(view.call).toHaveBeenCalled()
    expect(view.leaves()).toContain(SECOND_LEAF_ID)
    expect(view.plan(null)).toEqual([])
  })

  it('defers proven retirement until the transport clears and does not close twice', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan('remote:second')
    await view.receive(retiredSnapshot())
    expect(view.leaves()).toEqual([LEAF_ID])
    expect(view.plan('remote:second')).toEqual([])
    expect(view.plan(null)).toEqual([2])
    view.removeSecond()
    expect(view.plan(null)).toEqual([])
  })

  it('drops a pane another client moved to a new tab from its source tab, PTY kept', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan('remote:second')
    // The host moved the second pane, same terminal, into a new tab.
    await view.receive(
      snapshot(3, mountedLeaves, (leafId) => (leafId === LEAF_ID ? 'host-tab-1' : 'host-tab-2'))
    )
    const movedPtyId = toRemoteRuntimePtyId(`terminal-${SECOND_LEAF_ID}`, ENV)
    expect(view.call).not.toHaveBeenCalled()
    expect(view.leaves()).toEqual([LEAF_ID])
    expect(view.layoutOf('web-terminal-host-tab-2')?.ptyIdsByLeafId).toEqual({
      [SECOND_LEAF_ID]: movedPtyId
    })
    expect(view.planRemovals(movedPtyId)).toEqual({ closed: [], moved: [2] })
  })

  it('keeps this window’s own pending move when a snapshot from before the host move lands', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    const targetTabId = 'web-terminal-host-tab-2'
    view.moveSecondLocally(targetTabId)
    const release = beginPendingHostPaneMove(targetTabId, SECOND_LEAF_ID)
    try {
      await view.receive(snapshot(3))
    } finally {
      release()
    }
    // The binding stays an orphan candidate the host is asked about, not a stale copy to drop.
    expect(view.call).toHaveBeenCalled()
    expect(view.layoutOf(targetTabId)?.ptyIdsByLeafId).toEqual({
      [SECOND_LEAF_ID]: toRemoteRuntimePtyId(`terminal-${SECOND_LEAF_ID}`, ENV)
    })
  })

  it('clears deferred retirement when the host reintroduces the leaf before detach', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan('remote:second')
    await view.receive(retiredSnapshot())
    expect(view.plan('remote:second')).toEqual([])
    await view.receive(snapshot(4))
    expect(view.leaves()).toEqual(mountedLeaves)
    expect(view.plan(null)).toEqual([])
  })
})

function retiredSnapshotWithVersion(snapshotVersion: number): RuntimeMobileSessionTabsResult {
  return { ...retiredSnapshot(), snapshotVersion }
}
