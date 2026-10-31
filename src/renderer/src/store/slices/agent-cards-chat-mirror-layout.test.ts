import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { applyLocalStructuredSessionTabSnapshots } from '../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeTab } from './store-test-helpers'
import { collectLayoutLeafGroupIds } from './tabs/agent-cards-projection'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('agent cards under the local chat mirror', () => {
  it('keeps card groups off the layout when a chat inventory snapshot lands', () => {
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalTiledAgents: true
      }
    })
    const ids = ['t0', 't1']
    for (const id of ids) {
      store.getState().createUnifiedTab(WT, 'terminal', { id, label: `Agent ${id}` })
    }
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WT]: ids.map((id) => makeTab({ id, worktreeId: WT, launchAgent: 'claude' }))
      }
    })
    store.getState().syncAgentCards(WT)
    const cardGroupIds = store.getState().agentCardGroupIdsByWorktree[WT] ?? []
    expect(cardGroupIds).toHaveLength(2)
    const layoutBefore = store.getState().layoutByWorktree[WT]

    // An empty census is what Chat UI alone publishes before any chat opens.
    const snapshot: RuntimeMobileSessionTabsResult = {
      worktree: WT,
      publicationEpoch: 'structured:epoch-1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabGroups: [],
      tabs: []
    }
    store.setState(applyLocalStructuredSessionTabSnapshots(store.getState(), [snapshot]))

    const leafIds = collectLayoutLeafGroupIds(store.getState().layoutByWorktree[WT])
    expect(cardGroupIds.filter((groupId) => leafIds.has(groupId))).toEqual([])
    expect(store.getState().layoutByWorktree[WT]).toEqual(layoutBefore)
  })
})
