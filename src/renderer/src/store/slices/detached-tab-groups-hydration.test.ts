import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createTestStore, makeTabGroup, makeUnifiedTab, makeWorktree } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/tmp/feature'

describe('detached tab group hydration', () => {
  it('restores only live terminal-only groups and prunes stale bounds', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1' })]
      }
    })
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: 'terminal-1',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        [WORKTREE_ID]: [
          makeUnifiedTab({
            id: 'terminal-1',
            worktreeId: WORKTREE_ID,
            groupId: 'terminal-group'
          }),
          makeUnifiedTab({
            id: 'editor-1',
            worktreeId: WORKTREE_ID,
            groupId: 'mixed-group',
            contentType: 'editor'
          })
        ]
      },
      tabGroups: {
        [WORKTREE_ID]: [
          makeTabGroup({
            id: 'terminal-group',
            worktreeId: WORKTREE_ID,
            activeTabId: 'terminal-1',
            tabOrder: ['terminal-1']
          }),
          makeTabGroup({
            id: 'mixed-group',
            worktreeId: WORKTREE_ID,
            activeTabId: 'editor-1',
            tabOrder: ['editor-1']
          })
        ]
      },
      detachedGroupIds: ['terminal-group', 'mixed-group', 'missing-group'],
      auxWindowBoundsByGroupId: {
        'terminal-group': { x: 1, y: 2, width: 900, height: 600 },
        'mixed-group': { x: 3, y: 4, width: 900, height: 600 },
        'missing-group': { x: 5, y: 6, width: 900, height: 600 }
      }
    }

    store.getState().hydrateTabsSession(session)

    expect(store.getState().detachedGroupIds).toEqual(['terminal-group'])
    expect(store.getState().auxWindowBoundsByGroupId).toEqual({
      'terminal-group': { x: 1, y: 2, width: 900, height: 600 },
      'mixed-group': { x: 3, y: 4, width: 900, height: 600 }
    })
  })
})
