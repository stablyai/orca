import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
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

  it('resolves identical folder ids to the requested execution host', () => {
    const local = makeFolderWorkspace({ executionHostId: 'local', name: 'Local folder' })
    const runtime = makeFolderWorkspace({
      executionHostId: 'runtime:env-1',
      name: 'Runtime folder'
    })

    expect(
      getKnownSidebarWorktreeById(
        folderWorkspaceKey(runtime.id),
        new Map(),
        [local, runtime],
        [],
        'runtime:env-1'
      )
    ).toMatchObject({ hostId: 'runtime:env-1', displayName: 'Runtime folder' })
  })

  it('uses the owning group for legacy workspace host resolution', () => {
    const folderWorkspace = makeFolderWorkspace({ connectionId: 'legacy-target' })
    const runtimeGroup = makeProjectGroup({
      id: folderWorkspace.projectGroupId,
      executionHostId: 'runtime:env-1'
    })

    expect(
      getKnownSidebarWorktreeById(
        folderWorkspaceKey(folderWorkspace.id),
        new Map(),
        [folderWorkspace],
        [],
        'runtime:env-1',
        [runtimeGroup],
        'local'
      )
    ).toMatchObject({ hostId: 'runtime:env-1' })
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

  it('expands the requested host when folder and group ids collide', () => {
    const runtimeHostId = 'runtime:env-1' as const
    const groups = [
      makeProjectGroup({ id: 'group-child', name: 'Local', executionHostId: 'local' }),
      makeProjectGroup({
        id: 'group-child',
        name: 'Runtime',
        executionHostId: runtimeHostId
      })
    ]
    const workspaces = [
      makeFolderWorkspace({ name: 'Local', executionHostId: 'local' }),
      makeFolderWorkspace({ name: 'Runtime', executionHostId: runtimeHostId })
    ]

    expect(
      getFolderWorkspaceRevealGroupKeys(folderWorkspaceKey(workspaces[0]!.id), workspaces, groups, {
        groupBy: 'repo',
        defaultHostId: 'local',
        executionHostId: runtimeHostId
      })
    ).toEqual([
      getProjectGroupHeaderKey(JSON.stringify([runtimeHostId, 'group-child'])),
      `host:${runtimeHostId}`
    ])
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
})
