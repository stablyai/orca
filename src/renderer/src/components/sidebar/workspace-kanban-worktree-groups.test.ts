import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { groupWorkspaceKanbanWorktrees } from './workspace-kanban-worktree-groups'

function worktree({
  id,
  displayName,
  ...overrides
}: Partial<Worktree> & Pick<Worktree, 'id' | 'displayName'>): Worktree {
  return {
    repoId: 'repo',
    path: `/tmp/${id}`,
    head: 'head',
    branch: displayName,
    isBare: false,
    isMainWorktree: false,
    id,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

const statuses = [
  { id: 'todo', label: 'Todo' },
  { id: 'doing', label: 'Doing' }
]

describe('groupWorkspaceKanbanWorktrees', () => {
  it('uses manualOrder inside lanes when Manual sort is active', () => {
    const grouped = groupWorkspaceKanbanWorktrees({
      worktrees: [
        worktree({
          id: 'a',
          displayName: 'A',
          workspaceStatus: 'doing',
          manualOrder: 100,
          lastActivityAt: 10
        }),
        worktree({
          id: 'b',
          displayName: 'B',
          workspaceStatus: 'doing',
          manualOrder: 300,
          lastActivityAt: 1
        }),
        worktree({
          id: 'c',
          displayName: 'C',
          workspaceStatus: 'doing',
          manualOrder: 200,
          lastActivityAt: 50
        })
      ],
      visibleWorktreeIds: new Set(['a', 'b', 'c']),
      workspaceStatuses: statuses,
      sortBy: 'manual'
    })

    expect(grouped.get('doing')?.map((item) => item.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps pinned then recent ordering outside Manual sort', () => {
    const grouped = groupWorkspaceKanbanWorktrees({
      worktrees: [
        worktree({
          id: 'a',
          displayName: 'A',
          workspaceStatus: 'doing',
          isPinned: false,
          lastActivityAt: 50
        }),
        worktree({
          id: 'b',
          displayName: 'B',
          workspaceStatus: 'doing',
          isPinned: true,
          lastActivityAt: 1
        })
      ],
      visibleWorktreeIds: new Set(['a', 'b']),
      workspaceStatuses: statuses,
      sortBy: 'recent'
    })

    expect(grouped.get('doing')?.map((item) => item.id)).toEqual(['b', 'a'])
  })
})
