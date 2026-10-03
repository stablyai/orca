import { describe, expect, it } from 'vitest'
import type { TabCluster, TabGroup } from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { parseWorkspaceSession } from '../../../../../shared/workspace-session-schema'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { buildHydratedTabState } from '../tabs-hydration'
import { makeTabGroup, makeUnifiedTab } from '../store-test-helpers'
import { getHiddenClusterTabIds } from './tab-cluster-model'

const WT = 'repo1::/tmp/feature'
const PANE = 'pane'

function cluster(id: string, tabIds: string[], overrides: Partial<TabCluster> = {}): TabCluster {
  return { id, name: 'Work', color: 'pink', collapsed: true, tabIds, ...overrides }
}

function baseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

function roundTrip(ids: string[], pane: TabGroup, pinnedIds: readonly string[] = []): TabGroup {
  const persisted = buildPersistedUnifiedTabSessionData({
    unifiedTabsByWorktree: {
      [WT]: ids.map((id, sortOrder) =>
        makeUnifiedTab({
          id,
          worktreeId: WT,
          groupId: PANE,
          sortOrder,
          contentType: 'editor',
          isPinned: pinnedIds.includes(id)
        })
      )
    },
    groupsByWorktree: { [WT]: [pane] },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: PANE } },
    activeGroupIdByWorktree: { [WT]: PANE }
  })
  const parsed = parseWorkspaceSession({ ...baseSession(), ...persisted })
  if (!parsed.ok) {
    throw new Error('expected a valid persisted session')
  }
  return buildHydratedTabState(parsed.value, new Set([WT])).groupsByWorktree[WT][0]
}

describe('tab cluster session persistence', () => {
  it('round-trips the sticky member even when pane activation has moved outside its cluster', () => {
    const pane = makeTabGroup({
      id: PANE,
      worktreeId: WT,
      activeTabId: 'outside',
      tabOrder: ['a', 'b', 'outside'],
      tabClusters: [cluster('c', ['a', 'b'], { shownTabId: 'a' })]
    })
    const restored = roundTrip(['a', 'b', 'outside'], pane)
    expect(restored.tabOrder).toEqual(['a', 'b', 'outside'])
    expect(restored.tabClusters).toEqual([cluster('c', ['a', 'b'], { shownTabId: 'a' })])
    expect(restored.activeTabId).toBe('outside')
    expect([...getHiddenClusterTabIds(restored)]).toEqual(['b'])
  })

  it('drops stale ids and pinned members and gives duplicate members to the first cluster', () => {
    const pane = makeTabGroup({
      id: PANE,
      worktreeId: WT,
      tabOrder: ['stale', 'pin', 'a', 'b', 'c'],
      tabClusters: [
        cluster('first', ['stale', 'pin', 'a', 'a', 'b'], { shownTabId: 'pin' }),
        cluster('second', ['b', 'c'], { shownTabId: 'b' })
      ]
    })
    const restored = roundTrip(['pin', 'a', 'b', 'c'], pane, ['pin'])
    expect(restored.tabOrder).toEqual(['pin', 'a', 'b', 'c'])
    expect(restored.tabClusters).toEqual([cluster('first', ['a', 'b']), cluster('second', ['c'])])
  })

  it('keeps the longest contiguous run without reordering tabs during a round trip', () => {
    const ids = ['a', 'b', 'x', 'y', 'c', 'd', 'e']
    const pane = makeTabGroup({
      id: PANE,
      worktreeId: WT,
      tabOrder: ids,
      tabClusters: [cluster('c', ['a', 'b', 'c', 'd', 'e'])]
    })
    const restored = roundTrip(ids, pane)
    expect(restored.tabOrder).toEqual(ids)
    expect(restored.tabClusters).toEqual([cluster('c', ['c', 'd', 'e'])])
  })

  it('sandwich-joins missing membership and normalizes against tabs repaired into the persisted order', () => {
    const pane = makeTabGroup({
      id: PANE,
      worktreeId: WT,
      tabOrder: ['a', 'middle', 'b'],
      tabClusters: [cluster('c', ['a', 'b', 'appended'])]
    })
    const restored = roundTrip(['a', 'middle', 'b', 'appended'], pane)
    expect(restored.tabOrder).toEqual(['a', 'middle', 'b', 'appended'])
    expect(restored.tabClusters).toEqual([cluster('c', ['a', 'middle', 'b', 'appended'])])
  })

  it('omits tabClusters after its last member is pruned instead of persisting an empty array', () => {
    const restored = roundTrip(
      ['a'],
      makeTabGroup({
        id: PANE,
        worktreeId: WT,
        tabOrder: ['a'],
        tabClusters: [cluster('c', ['stale'])]
      })
    )
    expect(restored.tabOrder).toEqual(['a'])
    expect(Object.hasOwn(restored, 'tabClusters')).toBe(false)
  })

  it('keeps the pane when zod discards corrupt cluster metadata and hydrates its tabs', () => {
    const parsed = parseWorkspaceSession({
      ...baseSession(),
      unifiedTabs: {
        [WT]: [makeUnifiedTab({ id: 'a', worktreeId: WT, groupId: PANE, contentType: 'editor' })]
      },
      tabGroups: {
        [WT]: [
          {
            id: PANE,
            worktreeId: WT,
            activeTabId: 'a',
            tabOrder: ['a'],
            tabClusters: [
              { id: 'c', name: 'Work', color: 'blue', collapsed: 'broken', tabIds: ['a'] }
            ]
          }
        ]
      }
    })
    if (!parsed.ok) {
      throw new Error('expected corrupt metadata to be salvaged')
    }
    const restored = buildHydratedTabState(parsed.value, new Set([WT]))
    expect(restored.groupsByWorktree[WT][0].tabOrder).toEqual(['a'])
    expect(restored.groupsByWorktree[WT][0].activeTabId).toBe('a')
    expect(Object.hasOwn(restored.groupsByWorktree[WT][0], 'tabClusters')).toBe(false)
  })

  it('discards a corrupt sticky field without losing the cluster during hydration', () => {
    const parsed = parseWorkspaceSession({
      ...baseSession(),
      unifiedTabs: {
        [WT]: ['a', 'b'].map((id) =>
          makeUnifiedTab({ id, worktreeId: WT, groupId: PANE, contentType: 'editor' })
        )
      },
      tabGroups: {
        [WT]: [
          {
            id: PANE,
            worktreeId: WT,
            activeTabId: 'a',
            tabOrder: ['a', 'b'],
            tabClusters: [{ ...cluster('c', ['a', 'b']), shownTabId: 42 }]
          }
        ]
      }
    })
    if (!parsed.ok) {
      throw new Error('expected corrupt sticky metadata to be salvaged')
    }
    const restored = buildHydratedTabState(parsed.value, new Set([WT])).groupsByWorktree[WT][0]
    expect(restored.tabOrder).toEqual(['a', 'b'])
    expect(restored.tabClusters).toEqual([cluster('c', ['a', 'b'])])
    expect([...getHiddenClusterTabIds(restored)]).toEqual(['b'])
  })

  it('normalizes legacy persisted clusters directly against the hydrated ownership and pin state', () => {
    const ids = ['pin', 'a', 'b', 'x', 'y', 'c', 'd', 'e']
    const session: WorkspaceSessionState = {
      ...baseSession(),
      unifiedTabs: {
        [WT]: ids.map((id, sortOrder) =>
          makeUnifiedTab({
            id,
            worktreeId: WT,
            groupId: PANE,
            contentType: 'editor',
            sortOrder,
            isPinned: id === 'pin'
          })
        )
      },
      tabGroups: {
        [WT]: [
          makeTabGroup({
            id: PANE,
            worktreeId: WT,
            tabOrder: ['stale', ...ids, 'a'],
            tabClusters: [cluster('c', ['stale', 'pin', 'a', 'b', 'c', 'd', 'e', 'e'])]
          })
        ]
      }
    }
    const restored = buildHydratedTabState(session, new Set([WT])).groupsByWorktree[WT][0]
    expect(restored.tabOrder).toEqual(ids)
    expect(restored.tabClusters).toEqual([cluster('c', ['c', 'd', 'e'])])
  })

  it('rekeys editor aliases inside cluster membership during hydrated duplicate repair', () => {
    const session: WorkspaceSessionState = {
      ...baseSession(),
      unifiedTabs: {
        [WT]: [
          makeUnifiedTab({
            id: 'canonical',
            entityId: '/file.ts',
            worktreeId: WT,
            groupId: PANE,
            contentType: 'editor',
            sortOrder: 0
          }),
          makeUnifiedTab({
            id: 'alias',
            entityId: '/file.ts',
            worktreeId: WT,
            groupId: PANE,
            contentType: 'editor',
            sortOrder: 1
          }),
          makeUnifiedTab({
            id: 'other',
            worktreeId: WT,
            groupId: PANE,
            contentType: 'editor',
            sortOrder: 2
          })
        ]
      },
      tabGroups: {
        [WT]: [
          makeTabGroup({
            id: PANE,
            worktreeId: WT,
            tabOrder: ['alias', 'other'],
            tabClusters: [cluster('c', ['alias', 'other'], { shownTabId: 'alias' })]
          })
        ]
      }
    }
    const restored = buildHydratedTabState(session, new Set([WT])).groupsByWorktree[WT][0]
    expect(restored.tabOrder).toEqual(['canonical', 'other'])
    expect(restored.tabClusters).toEqual([
      cluster('c', ['canonical', 'other'], { shownTabId: 'canonical' })
    ])
  })

  it('does not persist foreign tab references as members of a different pane', () => {
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: {
        [WT]: [
          makeUnifiedTab({ id: 'a', worktreeId: WT, groupId: PANE, contentType: 'editor' }),
          makeUnifiedTab({ id: 'foreign', worktreeId: WT, groupId: 'other', contentType: 'editor' })
        ]
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: PANE,
            worktreeId: WT,
            tabOrder: ['a', 'foreign'],
            tabClusters: [cluster('c', ['a', 'foreign'])]
          }),
          makeTabGroup({ id: 'other', worktreeId: WT, tabOrder: ['foreign'] })
        ]
      },
      activeGroupIdByWorktree: { [WT]: PANE },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: PANE },
          second: { type: 'leaf', groupId: 'other' }
        }
      }
    })
    expect(persisted.tabGroups?.[WT][0].tabOrder).toEqual(['a'])
    expect(persisted.tabGroups?.[WT][0].tabClusters).toEqual([cluster('c', ['a'])])
  })
})
