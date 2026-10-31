import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { selectTiledAgentsReconcileKey } from '../../components/tab-group/tiled-pane-attention'
import { selectAgentCardPaneVisibilityKey } from '../../components/tab-group/agent-card-pane-visibility'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeTab } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('agent cards: reconcile key, visibility key and syncAgentCards agree end to end', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), experimentalTiledAgents: true }
    })
  })

  it('reacts to a real terminal-route agent tab and settles onto card groups each with an active tab', () => {
    expect(selectAgentCardPaneVisibilityKey(store.getState(), WT)).toBe('')
    const reconcileKeyBefore = selectTiledAgentsReconcileKey(store.getState(), WT)

    const ids = ['t0', 't1', 't2']
    for (const id of ids) {
      store.getState().createUnifiedTab(WT, 'terminal', { id, label: `Agent ${id}` })
    }
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WT]: ids.map((id) => makeTab({ id, worktreeId: WT, launchAgent: 'claude' }))
      }
    })

    expect(selectTiledAgentsReconcileKey(store.getState(), WT)).not.toBe(reconcileKeyBefore)

    const result = store.getState().syncAgentCards(WT)
    expect(result).toEqual({ carded: true, overflowTabIds: [] })

    const cardGroupIds = store.getState().agentCardGroupIdsByWorktree[WT] ?? []
    expect(cardGroupIds).toHaveLength(3)
    const groups = store.getState().groupsByWorktree[WT]
    for (const groupId of cardGroupIds) {
      const group = groups.find((candidate) => candidate.id === groupId)
      expect(group?.activeTabId).not.toBeNull()
      expect(group?.tabOrder).toContain(group?.activeTabId)
    }

    const visibilityKey = selectAgentCardPaneVisibilityKey(store.getState(), WT)
    expect(visibilityKey.startsWith('1||') || visibilityKey.startsWith('0||')).toBe(true)
    expect(visibilityKey.split('|')[2]?.split(',')).toEqual(cardGroupIds)

    const settledReconcileKey = selectTiledAgentsReconcileKey(store.getState(), WT)
    const settledCards = store.getState().agentCardGroupIdsByWorktree
    store.getState().syncAgentCards(WT)
    expect(selectTiledAgentsReconcileKey(store.getState(), WT)).toBe(settledReconcileKey)
    expect(store.getState().agentCardGroupIdsByWorktree).toBe(settledCards)
  })
})
