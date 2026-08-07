import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from './execution-host'
import type { FolderWorkspace, WorkspaceLineage, Worktree } from './types'
import { projectResolvedWorkspaceLineage } from './workspace-lineage-projection'
import { folderWorkspaceKey, worktreeWorkspaceKey } from './workspace-scope'

function makeWorktree(id: string, instanceId: string, hostId: ExecutionHostId = 'local'): Worktree {
  return {
    id,
    instanceId,
    repoId: id.split('::')[0],
    hostId,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    path: id,
    head: 'head',
    branch: 'branch',
    isBare: false,
    isSparse: false,
    isMainWorktree: false
  }
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-instance',
    projectGroupId: 'group-1',
    name: 'Project X',
    folderPath: '/project-x',
    executionHostId: 'local',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeLineage(
  child: Worktree,
  parentWorkspaceKey = folderWorkspaceKey('folder-instance'),
  parentInstanceId = 'folder-instance'
): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child.id),
    childInstanceId: child.instanceId,
    childHostId: child.hostId,
    parentWorkspaceKey,
    parentInstanceId,
    parentHostId: 'local',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}

describe('projectResolvedWorkspaceLineage', () => {
  it('projects an exact cross-repo child onto a folder workspace', () => {
    const child = makeWorktree('repo-app::/project-x/app-wt', 'child-instance')
    const lineage = makeLineage(child)

    const [projected] = projectResolvedWorkspaceLineage([child], [makeFolderWorkspace()], {
      [lineage.childWorkspaceKey]: lineage
    })

    expect(projected.workspaceLineage).toEqual(lineage)
  })

  it.each<[string, Partial<WorkspaceLineage>]>([
    ['missing parent instance', { parentInstanceId: null }],
    ['stale child instance', { childInstanceId: 'old-child' }],
    ['cross-host parent', { parentHostId: 'ssh:remote' }]
  ])('rejects %s', (_name, overrides) => {
    const child = makeWorktree('repo-app::/project-x/app-wt', 'child-instance')
    const lineage: WorkspaceLineage = { ...makeLineage(child), ...overrides }

    const [projected] = projectResolvedWorkspaceLineage([child], [makeFolderWorkspace()], {
      [lineage.childWorkspaceKey]: lineage
    })

    expect(projected.workspaceLineage).toBeNull()
  })

  it('rejects every edge in a worktree cycle', () => {
    const first = makeWorktree('repo-a::/a', 'instance-a')
    const second = makeWorktree('repo-b::/b', 'instance-b')
    const firstLineage = makeLineage(first, worktreeWorkspaceKey(second.id), second.instanceId)
    const secondLineage = makeLineage(second, worktreeWorkspaceKey(first.id), first.instanceId)

    const projected = projectResolvedWorkspaceLineage([first, second], [], {
      [firstLineage.childWorkspaceKey]: firstLineage,
      [secondLineage.childWorkspaceKey]: secondLineage
    })

    expect(projected.map((worktree) => worktree.workspaceLineage)).toEqual([null, null])
  })
})
