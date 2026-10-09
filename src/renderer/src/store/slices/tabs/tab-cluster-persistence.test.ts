import { describe, expect, it } from 'vitest'
import type { TabCluster } from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { parseWorkspaceSession } from '../../../../../shared/workspace-session-schema'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from '../store-test-helpers'

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

function restoreSession(session: WorkspaceSessionState) {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/tmp/feature' })]
    }
  })
  store.getState().hydrateTabsSession(session)
  return store.getState().groupsByWorktree[WT][0]
}

describe('tab cluster session persistence', () => {
  it('round-trips the sticky member even when pane activation has moved outside its cluster', () => {
    const store = createTestStore()
    seedStore(store, {
      unifiedTabsByWorktree: {
        [WT]: ['a', 'b', 'outside'].map((id, sortOrder) =>
          makeUnifiedTab({ id, worktreeId: WT, groupId: PANE, sortOrder, contentType: 'editor' })
        )
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: PANE,
            worktreeId: WT,
            activeTabId: 'outside',
            tabOrder: ['a', 'b', 'outside'],
            tabClusters: [cluster('c', ['a', 'b'], { shownTabId: 'a' })]
          })
        ]
      },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: PANE } },
      activeGroupIdByWorktree: { [WT]: PANE }
    })
    const persisted = buildPersistedUnifiedTabSessionData(store.getState())
    expect(persisted.tabGroups?.[WT][0].tabClusters).toEqual([
      cluster('c', ['a', 'b'], { shownTabId: 'a' })
    ])
    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify({ ...baseSession(), ...persisted }))
    )
    if (!parsed.ok) {
      throw new Error('expected a valid persisted session')
    }
    const restored = restoreSession(parsed.value)
    expect(restored.tabOrder).toEqual(['a', 'b', 'outside'])
    expect(restored.tabClusters).toEqual([cluster('c', ['a', 'b'], { shownTabId: 'a' })])
    expect(restored.activeTabId).toBe('outside')
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
    const restored = restoreSession(parsed.value)
    expect(restored.tabOrder).toEqual(['a'])
    expect(restored.activeTabId).toBe('a')
    expect(Object.hasOwn(restored, 'tabClusters')).toBe(false)
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
    const restored = restoreSession(parsed.value)
    expect(restored.tabOrder).toEqual(['a', 'b'])
    expect(restored.tabClusters).toEqual([cluster('c', ['a', 'b'])])
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
    const restored = restoreSession(session)
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
    expect(persisted.tabGroups?.[WT].map(({ id, tabOrder }) => ({ id, tabOrder }))).toEqual([
      { id: PANE, tabOrder: ['a'] },
      { id: 'other', tabOrder: ['foreign'] }
    ])
    expect(persisted.tabGroups?.[WT][0].tabClusters).toEqual([cluster('c', ['a'])])
  })
})
