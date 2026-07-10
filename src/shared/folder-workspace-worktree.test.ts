import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './types'
import { folderWorkspaceToWorktree } from './folder-workspace-worktree'

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    ...overrides,
    id: overrides.id ?? 'folder-workspace-1',
    projectGroupId: overrides.projectGroupId ?? 'group-1',
    name: overrides.name ?? 'Refund fix',
    folderPath: overrides.folderPath ?? '/workspace/platform',
    linkedTask: overrides.linkedTask ?? null,
    comment: overrides.comment ?? '',
    isArchived: overrides.isArchived ?? false,
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    sortOrder: overrides.sortOrder ?? 1,
    manualOrder: overrides.manualOrder,
    workspaceStatus: overrides.workspaceStatus,
    lastActivityAt: overrides.lastActivityAt ?? 2,
    createdAt: overrides.createdAt ?? 3,
    updatedAt: overrides.updatedAt ?? 4
  }
}

describe('folderWorkspaceToWorktree', () => {
  it('projects attached issue tasks without creating linked PR metadata', () => {
    const githubIssue = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        linkedTask: {
          provider: 'github',
          type: 'issue',
          number: 42,
          title: 'Refund flow fails',
          url: 'https://github.com/acme/app/issues/42'
        }
      })
    )
    const gitlabIssue = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        linkedTask: {
          provider: 'gitlab',
          type: 'issue',
          number: 7,
          title: 'Import fails',
          url: 'https://gitlab.com/acme/app/-/issues/7'
        }
      })
    )

    expect(githubIssue).toMatchObject({
      linkedIssue: 42,
      linkedPR: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null
    })
    expect(gitlabIssue).toMatchObject({
      linkedIssue: null,
      linkedPR: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: 7
    })
  })

  it('projects Linear tasks by identifier', () => {
    const worktree = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        linkedTask: {
          provider: 'linear',
          type: 'issue',
          number: 0,
          title: 'Polish folder workspaces',
          url: 'https://linear.app/acme/issue/ENG-123',
          linearIdentifier: 'ENG-123'
        }
      })
    )

    expect(worktree.linkedLinearIssue).toBe('ENG-123')
    expect(worktree.linkedPR).toBeNull()
    expect(worktree.linkedGitLabMR).toBeNull()
  })

  it('projects first-message rename state for folder workspace cards', () => {
    const worktree = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        createdWithAgent: 'codex',
        pendingFirstAgentMessageRename: true,
        firstAgentMessageRenameError: 'No model configured'
      })
    )

    expect(worktree).toMatchObject({
      createdWithAgent: 'codex',
      pendingFirstAgentMessageRename: true,
      firstAgentMessageRenameError: 'No model configured'
    })
  })

  it('keeps review-style tasks attached only to the folder workspace record', () => {
    const githubPr = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        linkedTask: {
          provider: 'github',
          type: 'pr',
          number: 99,
          title: 'Feature branch',
          url: 'https://github.com/acme/app/pull/99'
        }
      })
    )
    const gitlabMr = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        linkedTask: {
          provider: 'gitlab',
          type: 'mr',
          number: 12,
          title: 'Feature branch',
          url: 'https://gitlab.com/acme/app/-/merge_requests/12'
        }
      })
    )

    expect(githubPr.linkedPR).toBeNull()
    expect(githubPr.linkedIssue).toBeNull()
    expect(gitlabMr.linkedGitLabMR).toBeNull()
    expect(gitlabMr.linkedGitLabIssue).toBeNull()
  })
})
