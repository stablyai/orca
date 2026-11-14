import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import {
  getFolderWorkspaceHostIdentity,
  folderWorkspaceToWorktree,
  projectGroupIdFromRepoId
} from './folder-workspace-worktree'

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
  it.each([
    [{}, 'local|folder:folder-workspace-1'],
    [{ connectionId: 'ssh host' }, 'ssh:ssh%20host|folder:folder-workspace-1'],
    [
      { executionHostId: 'runtime:host' as const, connectionId: 'ignored' },
      'runtime:host|folder:folder-workspace-1'
    ],
    [
      { executionHostId: 'local' as const, connectionId: 'ignored' },
      'local|folder:folder-workspace-1'
    ]
  ])('keeps folder row identity on its explicit or legacy host %j', (fields, identity) => {
    const workspace = makeFolderWorkspace(fields)
    expect(getFolderWorkspaceHostIdentity(workspace)).toBe(identity)
    expect(folderWorkspaceToWorktree(workspace).hostId).toBe(identity.split('|')[0])
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

describe('recognising a folder workspace repoId', () => {
  // Use a long real repo id: short ids slice to empty even without a prefix check, hiding misclassification.
  it.each([
    'repo-1',
    'acme/app',
    '',
    'folder-workspace:',
    'a-repo-id-comfortably-longer-than-the-prefix'
  ])('reports no project group for %s', (repoId) => {
    expect(projectGroupIdFromRepoId(repoId)).toBeNull()
  })
})
