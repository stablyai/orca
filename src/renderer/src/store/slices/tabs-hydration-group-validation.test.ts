import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { buildHydratedTabState } from './tabs-hydration'

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('buildHydratedTabState group validation', () => {
  it('filters out invalid worktree IDs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ],
        w_gone: [
          {
            id: 't2',
            entityId: 't2',
            groupId: 'g2',
            worktreeId: 'w_gone',
            contentType: 'terminal',
            label: 'Gone',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [{ id: 'g1', worktreeId: 'w1', activeTabId: 't1', tabOrder: ['t1'] }],
        w_gone: [{ id: 'g2', worktreeId: 'w_gone', activeTabId: 't2', tabOrder: ['t2'] }]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1).toHaveLength(1)
    expect(result.unifiedTabsByWorktree.w_gone).toBeUndefined()
  })

  it('validates group references against hydrated tabs', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: 't1',
            entityId: 't1',
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Term',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: 'deleted-tab',
            tabOrder: ['deleted-tab', 't1']
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    const group = result.groupsByWorktree.w1[0]

    expect(group.activeTabId).toBeNull()
    expect(group.tabOrder).toEqual(['t1'])
  })
})
