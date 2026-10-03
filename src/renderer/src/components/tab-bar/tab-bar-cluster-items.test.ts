import { describe, expect, it } from 'vitest'
import type { TabCluster } from '../../../../shared/tab-types'
import { buildTabBarStripItems } from './tab-bar-cluster-items'
import type { TabBarItem } from './tab-bar-item-model'

function terminalItem(id: string): TabBarItem {
  return {
    type: 'terminal',
    id: `visible-${id}`,
    unifiedTabId: id,
    isPinned: false,
    data: {
      id: `visible-${id}`,
      worktreeId: 'wt',
      ptyId: null,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  }
}

const ITEMS = ['a', 'b', 'c', 'd', 'e'].map(terminalItem)
const CLUSTER: TabCluster = {
  id: 'cluster',
  name: 'Work',
  color: 'blue',
  collapsed: false,
  tabIds: ['b', 'c', 'd']
}
const CLUSTER_BY_TAB_ID = new Map(CLUSTER.tabIds.map((tabId) => [tabId, CLUSTER]))
const COLLAPSED_CLUSTER: TabCluster = { ...CLUSTER, collapsed: true }
const COLLAPSED_CLUSTER_BY_TAB_ID = new Map(
  COLLAPSED_CLUSTER.tabIds.map((tabId) => [tabId, COLLAPSED_CLUSTER])
)

describe('tab strip cluster projection', () => {
  it('inserts one chip before the first member and leaves ungrouped order alone', () => {
    const strip = buildTabBarStripItems(
      ITEMS,
      {
        id: 'pane',
        activeTabId: 'a',
        tabClusters: [CLUSTER]
      },
      CLUSTER_BY_TAB_ID
    )
    expect(strip.map((item) => item.id)).toEqual([
      'visible-a',
      'tab-cluster:pane:cluster',
      'visible-b',
      'visible-c',
      'visible-d',
      'visible-e'
    ])
    expect(ITEMS.map((item) => item.unifiedTabId)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('renders a collapsed chip and only its active member as sortable strip items', () => {
    const strip = buildTabBarStripItems(
      ITEMS,
      {
        id: 'pane',
        activeTabId: 'd',
        tabClusters: [COLLAPSED_CLUSTER]
      },
      COLLAPSED_CLUSTER_BY_TAB_ID
    )
    expect(strip.map((item) => item.id)).toEqual([
      'visible-a',
      'tab-cluster:pane:cluster',
      'visible-d',
      'visible-e'
    ])
  })

  it('retains a collapsed chip even when no member is the active tab', () => {
    const strip = buildTabBarStripItems(
      ITEMS,
      {
        id: 'pane',
        activeTabId: 'a',
        tabClusters: [COLLAPSED_CLUSTER]
      },
      COLLAPSED_CLUSTER_BY_TAB_ID
    )
    expect(strip.map((item) => item.id)).toEqual([
      'visible-a',
      'tab-cluster:pane:cluster',
      'visible-e'
    ])
  })

  it('places adjacent cluster chips in canonical member order, regardless of metadata order', () => {
    const second: TabCluster = {
      id: 'second',
      name: 'Other',
      color: 'pink',
      collapsed: false,
      tabIds: ['e']
    }
    expect(
      buildTabBarStripItems(
        ITEMS,
        {
          id: 'pane',
          activeTabId: 'a',
          tabClusters: [second, CLUSTER]
        },
        new Map<string, TabCluster>([...CLUSTER_BY_TAB_ID, ['e', second]])
      ).map((item) => item.id)
    ).toEqual([
      'visible-a',
      'tab-cluster:pane:cluster',
      'visible-b',
      'visible-c',
      'visible-d',
      'tab-cluster:pane:second',
      'visible-e'
    ])
  })

  it('does not show an orphan chip when its entire cluster is absent from the rendered content', () => {
    expect(
      buildTabBarStripItems(
        [ITEMS[0]!, ITEMS[4]!],
        {
          id: 'pane',
          activeTabId: 'a',
          tabClusters: [CLUSTER]
        },
        CLUSTER_BY_TAB_ID
      ).map((item) => item.id)
    ).toEqual(['visible-a', 'visible-e'])
  })

  it('gives equal-id clusters in different panes distinct sortable identities', () => {
    const chipIds = ['source', 'target'].map((groupId) => {
      const tabId = `${groupId}-tab`
      const cluster: TabCluster = { ...CLUSTER, id: 'same', collapsed: true, tabIds: [tabId] }
      const strip = buildTabBarStripItems(
        [terminalItem(tabId)],
        {
          id: groupId,
          activeTabId: null,
          tabClusters: [cluster]
        },
        new Map([[tabId, cluster]])
      )
      return strip.find((item) => item.type === 'cluster')?.id
    })
    expect(chipIds).toEqual(['tab-cluster:source:same', 'tab-cluster:target:same'])
  })
})
