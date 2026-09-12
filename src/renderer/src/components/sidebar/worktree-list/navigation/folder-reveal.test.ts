import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getFolderWorkspaceRevealGroupKeys,
  getKnownSidebarWorktreeById,
  sidebarWorkspaceStillExists
} from './folder-reveal'
import { getProjectGroupHeaderKey } from '../grouping/group-keys'

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-child',
    name: 'Refund workflow',
    folderPath: '/workspace/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup>): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 1,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}
function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    displayName: 'repo-1',
    badgeColor: '#000000',
    addedAt: 1,
    path: '/workspace/repo-1',
    projectGroupId: null,
    ...overrides
  }
}

function makeWorktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/workspace/repo/${id}`,
    displayName: id,
    branch: id,
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
    sortOrder: 1,
    lastActivityAt: 1
  }
}

describe('worktree list folder reveal', () => {
  it('resolves synthetic folder workspace ids as known sidebar worktrees', () => {
    const folderWorkspace = makeFolderWorkspace()
    const folderWorktree = getKnownSidebarWorktreeById(
      folderWorkspaceKey(folderWorkspace.id),
      new Map(),
      [folderWorkspace]
    )

    expect(folderWorktree).toMatchObject({
      id: folderWorkspaceKey(folderWorkspace.id),
      displayName: folderWorkspace.name,
      path: folderWorkspace.folderPath
    })
  })

  it('keeps pending reveals alive for folder workspaces missing from raw git worktrees', () => {
    const folderWorkspace = makeFolderWorkspace()
    const gitWorktree = makeWorktree('git-worktree-1')

    expect(
      sidebarWorkspaceStillExists(
        folderWorkspaceKey(folderWorkspace.id),
        [gitWorktree],
        [folderWorkspace]
      )
    ).toBe(true)
    expect(sidebarWorkspaceStillExists('missing-worktree', [gitWorktree], [folderWorkspace])).toBe(
      false
    )
  })

  it('returns project group keys from root to nested folder workspace owner', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const child = makeProjectGroup({
      id: 'group-child',
      name: 'Platform',
      parentGroupId: root.id
    })
    const folderWorkspace = makeFolderWorkspace({ projectGroupId: child.id })

    expect(
      getFolderWorkspaceRevealGroupKeys(
        folderWorkspaceKey(folderWorkspace.id),
        [folderWorkspace],
        [child, root]
      )
    ).toEqual([getProjectGroupHeaderKey(root.id), getProjectGroupHeaderKey(child.id)])
  })

  it('accepts raw folder workspace id as well as scoped key (#20113)', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const child = makeProjectGroup({
      id: 'group-child',
      name: 'Platform',
      parentGroupId: root.id
    })
    const folderWorkspace = makeFolderWorkspace({ projectGroupId: child.id })

    expect(
      getFolderWorkspaceRevealGroupKeys(folderWorkspace.id, [folderWorkspace], [child, root])
    ).toEqual([getProjectGroupHeaderKey(root.id), getProjectGroupHeaderKey(child.id)])
  })

  it('resolves project group keys for git worktrees when worktrees and repoMap are provided (#20113)', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const child = makeProjectGroup({
      id: 'group-child',
      name: 'Platform',
      parentGroupId: root.id
    })
    const repo = makeRepo({ id: 'repo-1', projectGroupId: child.id })
    const worktree = makeWorktree('wt-1')

    const keys = getFolderWorkspaceRevealGroupKeys('wt-1', [], [child, root], {
      worktrees: [worktree],
      repoMap: new Map([[repo.id, repo]])
    })

    expect(keys).toEqual([
      getProjectGroupHeaderKey(root.id),
      getProjectGroupHeaderKey(child.id),
      'project:repo-1'
    ])
  })

  it('narrows git worktree reveal to the specified execution host (#20113)', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const repo = makeRepo({ id: 'repo-1', projectGroupId: root.id })
    const localWorktree = { ...makeWorktree('wt-1'), hostId: 'local' as const }
    const remoteWorktree = { ...makeWorktree('wt-1'), hostId: 'ssh:builder' as const }

    const keys = getFolderWorkspaceRevealGroupKeys('wt-1', [], [root], {
      worktrees: [localWorktree, remoteWorktree],
      repoMap: new Map([[repo.id, repo]]),
      executionHostId: 'ssh:builder'
    })

    expect(keys).toEqual([getProjectGroupHeaderKey(root.id), 'project:repo-1'])

    // When asking for a different host that has no matching worktree, returns empty
    const mismatchKeys = getFolderWorkspaceRevealGroupKeys('wt-1', [], [root], {
      worktrees: [localWorktree],
      repoMap: new Map([[repo.id, repo]]),
      executionHostId: 'ssh:builder'
    })
    expect(mismatchKeys).toEqual([])
  })

  it('narrows folder workspace reveal to the specified execution host (#20113)', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const child = makeProjectGroup({
      id: 'group-child',
      name: 'Platform',
      parentGroupId: root.id
    })
    const localFolderWorkspace = makeFolderWorkspace({
      id: 'fw-1',
      projectGroupId: child.id,
      executionHostId: 'local'
    })
    const remoteFolderWorkspace = makeFolderWorkspace({
      id: 'fw-1',
      projectGroupId: child.id,
      executionHostId: 'ssh:builder'
    })

    const remoteKeys = getFolderWorkspaceRevealGroupKeys(
      'fw-1',
      [localFolderWorkspace, remoteFolderWorkspace],
      [child, root],
      { executionHostId: 'ssh:builder' }
    )
    expect(remoteKeys).toEqual([
      getProjectGroupHeaderKey(root.id),
      getProjectGroupHeaderKey(child.id)
    ])

    const mismatchKeys = getFolderWorkspaceRevealGroupKeys(
      'fw-1',
      [localFolderWorkspace],
      [child, root],
      { executionHostId: 'ssh:builder' }
    )
    expect(mismatchKeys).toEqual([])
  })
})

describe('reveal keys under non-repo grouping', () => {
  const group = makeProjectGroup({ id: 'group-child', connectionId: 'target-1' })
  const folderWorkspace = makeFolderWorkspace({ workspaceStatus: 'in-progress' })
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)

  it('returns the status lane key so a collapsed lane can be expanded', () => {
    // Pre-fix only project-group headers came back, and those do not exist
    // under status grouping, so the reveal could never expand the lane.
    const keys = getFolderWorkspaceRevealGroupKeys(workspaceKey, [folderWorkspace], [group], {
      groupBy: 'workspace-status',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })
    expect(keys).toContain('workspace-status:in-progress')
  })

  it('returns the host key so a collapsed host can be expanded too', () => {
    const keys = getFolderWorkspaceRevealGroupKeys(workspaceKey, [folderWorkspace], [group], {
      groupBy: 'workspace-status',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })
    expect(keys).toContain('host:ssh:target-1')
  })

  it('still returns project-group keys under repo grouping', () => {
    const keys = getFolderWorkspaceRevealGroupKeys(workspaceKey, [folderWorkspace], [group], {
      groupBy: 'repo',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })
    expect(keys).toContain(getProjectGroupHeaderKey(group.id))
    expect(keys.some((key) => key.startsWith('workspace-status:'))).toBe(false)
  })

  it('returns status lane and host keys for git worktrees under workspace-status grouping (#20113)', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const repo = makeRepo({ id: 'repo-1', projectGroupId: root.id })
    const worktree: Worktree = {
      ...makeWorktree('wt-1'),
      workspaceStatus: 'in-progress'
    }

    const keys = getFolderWorkspaceRevealGroupKeys('wt-1', [], [root], {
      worktrees: [worktree],
      repoMap: new Map([[repo.id, repo]]),
      groupBy: 'workspace-status',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })

    expect(keys).toContain(getProjectGroupHeaderKey(root.id))
    expect(keys).toContain('workspace-status:in-progress')
    expect(keys).toContain('host:local')
  })

  it('returns all lane and host keys for git worktrees under none grouping (#20113)', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const repo = makeRepo({ id: 'repo-1', projectGroupId: root.id })
    const worktree = makeWorktree('wt-1')

    const keys = getFolderWorkspaceRevealGroupKeys('wt-1', [], [root], {
      worktrees: [worktree],
      repoMap: new Map([[repo.id, repo]]),
      groupBy: 'none',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })

    expect(keys).toContain(getProjectGroupHeaderKey(root.id))
    expect(keys).toContain('all')
    expect(keys).toContain('host:local')
  })
})
