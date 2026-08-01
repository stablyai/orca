import { describe, expect, it } from 'vitest'
import { createTestStore, makeTabGroup, makeUnifiedTab, makeWorktree } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'
const PHANTOM_GROUP_ID = 'group-that-vanished'

function seedWorktree(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
}

describe('closeUnifiedTab with a missing group record', () => {
  it('closes a tab whose group record is gone instead of leaving it in the strip', () => {
    const store = createTestStore()
    seedWorktree(store)
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({ id: 'tab-1', worktreeId: WORKTREE_ID, groupId: PHANTOM_GROUP_ID }),
          makeUnifiedTab({ id: 'tab-2', worktreeId: WORKTREE_ID, groupId: PHANTOM_GROUP_ID })
        ]
      },
      groupsByWorktree: { [WORKTREE_ID]: [] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: PHANTOM_GROUP_ID }
    })

    const result = store.getState().closeUnifiedTab('tab-1')

    expect(result).toEqual({ closedTabId: 'tab-1', wasLastTab: false, worktreeId: WORKTREE_ID })
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'tab-2'
    ])
  })

  it('reports the last orphan as such so callers can fall back to the empty state', () => {
    const store = createTestStore()
    seedWorktree(store)
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({ id: 'tab-1', worktreeId: WORKTREE_ID, groupId: PHANTOM_GROUP_ID })
        ]
      },
      groupsByWorktree: { [WORKTREE_ID]: [] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: PHANTOM_GROUP_ID }
    })

    expect(store.getState().closeUnifiedTab('tab-1')?.wasLastTab).toBe(true)
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID]).toHaveLength(0)
  })

  it('repoints the worktree at a real group once the phantom group has no tabs left', () => {
    const store = createTestStore()
    seedWorktree(store)
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({ id: 'tab-1', worktreeId: WORKTREE_ID, groupId: PHANTOM_GROUP_ID }),
          makeUnifiedTab({ id: 'tab-2', worktreeId: WORKTREE_ID, groupId: 'group-live' })
        ]
      },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          makeTabGroup({
            id: 'group-live',
            worktreeId: WORKTREE_ID,
            activeTabId: 'tab-2',
            tabOrder: ['tab-2']
          })
        ]
      },
      activeGroupIdByWorktree: { [WORKTREE_ID]: PHANTOM_GROUP_ID }
    })

    store.getState().closeUnifiedTab('tab-1')

    // Why: the strip renders the active group's tabs, so a phantom id would render empty here.
    expect(store.getState().activeGroupIdByWorktree[WORKTREE_ID]).toBe('group-live')
    expect(store.getState().groupsByWorktree[WORKTREE_ID].map((group) => group.id)).toEqual([
      'group-live'
    ])
  })

  // Why: nextGroups[0] can be an empty split, which re-creates the empty strip this repoint exists
  // to prevent.
  it('repoints at a group that actually has tabs rather than the first empty split', () => {
    const store = createTestStore()
    seedWorktree(store)
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({ id: 'tab-1', worktreeId: WORKTREE_ID, groupId: PHANTOM_GROUP_ID }),
          makeUnifiedTab({ id: 'tab-2', worktreeId: WORKTREE_ID, groupId: 'group-populated' })
        ]
      },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          makeTabGroup({ id: 'group-empty', worktreeId: WORKTREE_ID, tabOrder: [] }),
          makeTabGroup({
            id: 'group-populated',
            worktreeId: WORKTREE_ID,
            activeTabId: 'tab-2',
            tabOrder: ['tab-2']
          })
        ]
      },
      activeGroupIdByWorktree: { [WORKTREE_ID]: PHANTOM_GROUP_ID }
    })

    store.getState().closeUnifiedTab('tab-1')

    expect(store.getState().activeGroupIdByWorktree[WORKTREE_ID]).toBe('group-populated')
  })

  it('leaves a live group record untouched', () => {
    const store = createTestStore()
    seedWorktree(store)
    const tab = store.getState().createUnifiedTab(WORKTREE_ID, 'terminal')
    store.getState().createUnifiedTab(WORKTREE_ID, 'terminal')
    const groupId = store.getState().groupsByWorktree[WORKTREE_ID][0].id

    store.getState().closeUnifiedTab(tab.id)

    expect(store.getState().activeGroupIdByWorktree[WORKTREE_ID]).toBe(groupId)
    expect(store.getState().groupsByWorktree[WORKTREE_ID][0].tabOrder).not.toContain(tab.id)
  })
})
