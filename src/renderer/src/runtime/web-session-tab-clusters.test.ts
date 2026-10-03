import { describe, expect, it } from 'vitest'
import type { TabGroup } from '../../../shared/tab-types'
import { reconcileClientOwnedTabPlacement } from './web-session-client-owned-tab-placement'
import { getHiddenClusterTabIds } from '../store/slices/tabs/tab-cluster-model'

const group: TabGroup = {
  id: 'pane',
  worktreeId: 'wt',
  activeTabId: 'local-b',
  tabOrder: ['local-a', 'local-b'],
  tabClusters: [
    { id: 'work', name: 'Work', color: 'blue', collapsed: true, tabIds: ['local-a', 'local-b'] }
  ]
}

describe('web-session cluster presentation', () => {
  it('rekeys client-owned cluster members when the host adopts a local editor identity', () => {
    const result = reconcileClientOwnedTabPlacement({
      currentGroups: [group],
      worktreeId: 'wt',
      validUnifiedTabIds: new Set(['local-a', 'mirrored-b']),
      adoptedTabs: [],
      placementMoves: [],
      rekeyedTabIds: new Map([['local-b', 'mirrored-b']]),
      intentTabId: null,
      reservedEmptyGroupFallbackTabId: null,
      currentActiveGroupId: group.id,
      currentLayout: { type: 'leaf', groupId: group.id },
      isGroupReserved: () => false
    })
    const retained = result.groups?.[0]
    expect(retained?.tabOrder).toEqual(['local-a', 'mirrored-b'])
    expect(retained?.tabClusters?.[0].tabIds).toEqual(['local-a', 'mirrored-b'])
    expect(retained?.activeTabId).toBe('mirrored-b')
    if (!retained) {
      throw new Error('Expected client-owned pane')
    }
    expect([...getHiddenClusterTabIds(retained)]).toEqual(['local-a'])
  })
})
