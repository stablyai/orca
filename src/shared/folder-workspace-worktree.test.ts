import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import {
  folderWorkspaceRepoId,
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

  it('projects durable Jira item and source context without legacy issue zero', () => {
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'group-1',
      hostId: 'local' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    }
    const worktree = folderWorkspaceToWorktree(
      makeFolderWorkspace({
        linkedTask: {
          provider: 'jira',
          type: 'issue',
          number: 0,
          title: 'ORCA-123 Link Jira',
          url: 'https://company.atlassian.net/browse/ORCA-123',
          jiraIdentifier: 'ORCA-123'
        },
        linkedTaskSourceContext
      })
    )

    expect(worktree.linkedIssue).toBeNull()
    expect(worktree.linkedWorkItem).toMatchObject({
      provider: 'jira',
      jiraIdentifier: 'ORCA-123'
    })
    expect(worktree.linkedTaskSourceContext).toEqual(linkedTaskSourceContext)
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

  it('projects runtime ownership from the folder execution host', () => {
    const worktree = folderWorkspaceToWorktree(
      makeFolderWorkspace({ executionHostId: 'runtime:shared%20server' })
    )

    expect(worktree).toMatchObject({
      hostId: 'runtime:shared%20server',
      runtimeOwnerEnvironmentId: 'shared server'
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

describe('recognising a folder workspace repoId', () => {
  // The defect this exists for: a folder workspace's repoId is NEVER null, so code that tests for
  // absence to mean "no git repo" takes the repo branch and renders the raw synthetic id.
  it('never mints a null repoId, so absence cannot be the test for having no repo', () => {
    const worktree = folderWorkspaceToWorktree(makeFolderWorkspace({ projectGroupId: 'group-9' }))

    expect(worktree.repoId).not.toBeNull()
    expect(projectGroupIdFromRepoId(worktree.repoId)).toBe('group-9')
  })

  it('round-trips the project group through the id it mints', () => {
    expect(projectGroupIdFromRepoId(folderWorkspaceRepoId('4c3c3452-758b'))).toBe('4c3c3452-758b')
  })

  // A real git repo id must not be mistaken for a project group, or a repo would lose its own name.
  // The long id is the one that DISCRIMINATES: anything shorter than the prefix slices to an empty
  // string and reads as null even with no prefix check, so short fixtures alone prove nothing.
  it.each([
    'repo-1',
    'acme/app',
    '',
    'folder-workspace:',
    'a-repo-id-comfortably-longer-than-the-prefix'
  ])('reports no project group for %s', (repoId) => {
    expect(projectGroupIdFromRepoId(repoId)).toBeNull()
  })

  it('reports no project group for an absent repoId', () => {
    expect(projectGroupIdFromRepoId(null)).toBeNull()
    expect(projectGroupIdFromRepoId(undefined)).toBeNull()
  })
})
