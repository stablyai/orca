import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { collectLeafIds } from '../components/terminal-pane/terminal-pane-layout-tree'
import {
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds,
  trackRetiredLeafIds
} from '../components/terminal-pane/terminal-live-layout-reconciliation'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import {
  ENV,
  LEAF_ID,
  SECOND_LEAF_ID,
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

function snapshot(version: number, leaves = mountedLeaves): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    leaves.map((leafId) => ({
      type: 'terminal' as const,
      id: `host-tab-1::${leafId}`,
      parentTabId: 'host-tab-1',
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

  function plan(secondPtyId: string | null): number[] {
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
      ptyIdForPane: (pane) => (pane === 1 ? 'remote:first' : secondPtyId)
    })
  }

  return {
    call,
    plan,
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
