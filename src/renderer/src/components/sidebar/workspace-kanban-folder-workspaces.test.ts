import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildWorkspaceBoardWorktrees } from './workspace-kanban-folder-workspaces'

function worktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo-a',
    displayName: id,
    path: `/${id}`,
    branch: `feature/${id}`,
    isPinned: false,
    isArchived: false,
    sortOrder: 0,
    lastActivityAt: 1,
    workspaceStatus: 'todo'
  } as unknown as Worktree
}

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'API-123 : Fix checkout',
    folderPath: '/tickets/API-123',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    workspaceStatus: 'in-review',
    ...overrides
  }
}

function attached(folderId: string, worktreeId: string): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(worktreeId),
    parentWorkspaceKey: folderWorkspaceKey(folderId),
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

describe('buildWorkspaceBoardWorktrees', () => {
  it('adds each live folder workspace as a board row carrying its own status', () => {
    const rows = buildWorkspaceBoardWorktrees({
      worktrees: [worktree('repo-a::/alpha')],
      folderWorkspaces: [folderWorkspace()],
      workspaceLineageByChildKey: {}
    })

    expect(rows.map((row) => row.id)).toEqual(['repo-a::/alpha', 'folder:fw-1'])
    expect(rows[1]).toMatchObject({
      displayName: 'API-123 : Fix checkout',
      workspaceStatus: 'in-review'
    })
  })

  it('folds an attached worktree into its folder workspace card', () => {
    const rows = buildWorkspaceBoardWorktrees({
      worktrees: [worktree('repo-a::/alpha'), worktree('repo-a::/beta')],
      folderWorkspaces: [folderWorkspace()],
      workspaceLineageByChildKey: {
        [worktreeWorkspaceKey('repo-a::/beta')]: attached('fw-1', 'repo-a::/beta')
      }
    })

    expect(rows.map((row) => row.id)).toEqual(['repo-a::/alpha', 'folder:fw-1'])
  })

  it('keeps an attached worktree on the board when its folder workspace is archived', () => {
    const rows = buildWorkspaceBoardWorktrees({
      worktrees: [worktree('repo-a::/beta')],
      folderWorkspaces: [folderWorkspace({ isArchived: true })],
      workspaceLineageByChildKey: {
        [worktreeWorkspaceKey('repo-a::/beta')]: attached('fw-1', 'repo-a::/beta')
      }
    })

    expect(rows.map((row) => row.id)).toEqual(['repo-a::/beta'])
  })
})
