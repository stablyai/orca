import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, WorkspaceLineage, Worktree } from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { getFolderSupervisionLabels } from './folder-supervision-labels'

const folder: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Story Korean',
  folderPath: '/story-korean',
  executionHostId: 'local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const worktree: Worktree = {
  id: 'repo-app::/worktrees/worker',
  repoId: 'repo-app',
  path: '/worktrees/worker',
  displayName: 'worker',
  branch: 'refs/heads/worker',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  instanceId: 'child-instance',
  hostId: 'local'
}

function lineage(overrides: Partial<WorkspaceLineage> = {}): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
    childInstanceId: worktree.instanceId,
    childHostId: worktree.hostId,
    parentWorkspaceKey: folderWorkspaceKey(folder.id),
    parentInstanceId: folder.id,
    parentHostId: 'local',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}

describe('getFolderSupervisionLabels', () => {
  it('labels a valid cross-repo child with its folder workspace', () => {
    expect(
      getFolderSupervisionLabels({
        worktrees: [worktree],
        folderWorkspaces: [folder],
        workspaceLineageByChildKey: {
          [worktreeWorkspaceKey(worktree.id)]: lineage()
        }
      })
    ).toEqual(new Map([[worktree.id, 'Story Korean']]))
  })

  it('omits stale, archived, and non-folder lineage', () => {
    const stale = lineage({ childInstanceId: 'old-instance' })
    expect(
      getFolderSupervisionLabels({
        worktrees: [worktree],
        folderWorkspaces: [folder],
        workspaceLineageByChildKey: { [worktreeWorkspaceKey(worktree.id)]: stale }
      })
    ).toEqual(new Map())

    expect(
      getFolderSupervisionLabels({
        worktrees: [{ ...worktree, isArchived: true }],
        folderWorkspaces: [folder],
        workspaceLineageByChildKey: {
          [worktreeWorkspaceKey(worktree.id)]: lineage()
        }
      })
    ).toEqual(new Map())

    expect(
      getFolderSupervisionLabels({
        worktrees: [worktree],
        folderWorkspaces: [folder],
        workspaceLineageByChildKey: {
          [worktreeWorkspaceKey(worktree.id)]: lineage({
            parentWorkspaceKey: worktreeWorkspaceKey('parent-worktree')
          })
        }
      })
    ).toEqual(new Map())
  })
})
