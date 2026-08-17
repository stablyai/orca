import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { listTerminalMoveWorktreeDestinations } from './move-terminal-to-worktree-destinations'

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: 'repo',
    path: '/tmp',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.id,
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
  }
}

describe('listTerminalMoveWorktreeDestinations', () => {
  it('lists other worktrees as displayName plus branch and excludes floating/source', () => {
    const destinations = listTerminalMoveWorktreeDestinations({
      sourceWorktreeId: 'repo::/src',
      worktreesByRepo: {
        repo: [
          worktree({ id: 'repo::/src', displayName: 'src', branch: 'refs/heads/src' }),
          worktree({
            id: 'repo::/dest',
            displayName: 'follow-up',
            branch: 'refs/heads/follow-up'
          }),
          worktree({
            id: FLOATING_TERMINAL_WORKTREE_ID,
            displayName: 'Floating',
            branch: ''
          }),
          worktree({ id: 'repo::/old', displayName: 'old', isArchived: true })
        ]
      }
    })

    expect(destinations).toEqual([
      {
        id: 'repo::/dest',
        displayName: 'follow-up',
        branch: 'refs/heads/follow-up',
        label: 'follow-up'
      }
    ])
  })

  it('includes folder workspaces as destinations', () => {
    const folder: FolderWorkspace = {
      id: 'docs',
      projectGroupId: 'group',
      name: 'Docs',
      folderPath: '/docs',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const destinations = listTerminalMoveWorktreeDestinations({
      sourceWorktreeId: 'repo::/src',
      worktreesByRepo: { repo: [worktree({ id: 'repo::/src', displayName: 'src' })] },
      folderWorkspaces: [folder]
    })

    expect(destinations.map((destination) => destination.id)).toEqual([
      folderWorkspaceKey('docs')
    ])
    expect(destinations[0]?.label).toBe('Docs')
  })
})
