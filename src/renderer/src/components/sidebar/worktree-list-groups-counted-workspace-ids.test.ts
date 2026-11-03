import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspace-worktree'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

// Worktrees without a host stamp key under the empty host, as getWorktreeHostIdentity keys them.
const key = (worktreeId: string): string => composeWorktreeHostIdentity(undefined, worktreeId)

function makeProjectGroup(overrides: Partial<ProjectGroup> & { id: string }): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeFolderWorkspace(id: string, projectGroupId: string): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/platform/${id}`,
    connectionId: null,
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
}

const FOLDER_1_KEY = getFolderWorkspaceHostIdentity({ id: 'folder-1' })

function headerByKey(rows: ReturnType<typeof buildRows>, key: string) {
  const header = rows.find((row) => row.type === 'header' && row.key === key)
  if (header?.type !== 'header') {
    throw new Error(`no header row for ${key}`)
  }
  return header
}

describe('countedWorkspaceIds on group headers', () => {
  it('lists a repo header s own worktrees', () => {
    const second: Worktree = { ...worktree, id: 'wt-2', displayName: 'second' }

    const rows = buildRows('repo', [worktree, second], new Map([[repo.id, repo]]), null, new Set())

    expect(headerByKey(rows, `repo:${repo.id}`).countedWorkspaceIds).toEqual([
      key('wt-1'),
      key('wt-2')
    ])
  })

  it('keeps twins of one repo on two hosts apart in each host slice', () => {
    const local: Worktree = { ...worktree, hostId: 'local' }
    const remote: Worktree = { ...worktree, hostId: 'ssh:box' }
    const localKey = composeWorktreeHostIdentity('local', worktree.id)
    const remoteKey = composeWorktreeHostIdentity('ssh:box', worktree.id)

    const rows = buildRows(
      'workspace-status',
      [local, remote],
      new Map([[repo.id, repo]]),
      null,
      new Set()
    )
    const laneHeader = rows.find(
      (row) => row.type === 'header' && row.key.startsWith('workspace-status:')
    )
    if (laneHeader?.type !== 'header') {
      throw new Error('no status lane header')
    }

    expect(laneHeader.countedWorkspaceIds).toEqual([localKey, remoteKey])
    expect(laneHeader.hostCountedWorkspaceIds?.get('local')).toEqual([localKey])
    expect(laneHeader.hostCountedWorkspaceIds?.get('ssh:box')).toEqual([remoteKey])
  })

  it('aggregates a project group subtree over nested groups and folder workspaces', () => {
    const parent = makeProjectGroup({ id: 'group-parent', name: 'Platform' })
    const child = makeProjectGroup({
      id: 'group-child',
      name: 'Services',
      parentGroupId: parent.id,
      tabOrder: 1
    })
    const parentRepo: Repo = { ...repo, projectGroupId: parent.id }
    const childRepo: Repo = {
      ...repo,
      id: 'repo-2',
      displayName: 'billing',
      projectGroupId: child.id
    }
    const parentWorktree: Worktree = { ...worktree, id: 'wt-parent', repoId: parentRepo.id }
    const childWorktree: Worktree = { ...worktree, id: 'wt-child', repoId: childRepo.id }
    const folderWorkspace = makeFolderWorkspace('folder-1', child.id)

    const rows = buildRows(
      'repo',
      [parentWorktree, childWorktree],
      new Map([
        [parentRepo.id, parentRepo],
        [childRepo.id, childRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      false,
      undefined,
      [parent, { ...child, parentPath: '/platform' }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [folderWorkspace]
    )

    const parentHeader = headerByKey(rows, `project-group:${parent.id}`)
    // Folder workspaces are keyed by host identity, like the attention set keys them.
    expect([...(parentHeader.countedWorkspaceIds ?? [])].sort()).toEqual([
      FOLDER_1_KEY,
      key('wt-child'),
      key('wt-parent')
    ])
    // The existing count stays child projects plus folder workspaces, which is a different number.
    expect(parentHeader.count).toBe(3)

    expect([...(headerByKey(rows, `project-group:${child.id}`).countedWorkspaceIds ?? [])].sort()) //
      .toEqual([FOLDER_1_KEY, key('wt-child')])
  })

  it('gives the flat All header its workspaces so the badge works in that grouping', () => {
    const group = makeProjectGroup({ id: 'group-1', name: 'Platform', parentPath: '/platform' })
    const groupedRepo: Repo = { ...repo, projectGroupId: group.id }

    const rows = buildRows(
      'none',
      [{ ...worktree, repoId: groupedRepo.id }],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      false,
      undefined,
      [group],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [makeFolderWorkspace('folder-1', group.id)]
    )

    expect([...(headerByKey(rows, 'all').countedWorkspaceIds ?? [])].sort()).toEqual([
      FOLDER_1_KEY,
      key('wt-1')
    ])
  })

  it('counts folder workspaces in a status lane', () => {
    const group = makeProjectGroup({ id: 'group-1', name: 'Platform', parentPath: '/platform' })
    const groupedRepo: Repo = { ...repo, projectGroupId: group.id }

    const rows = buildRows(
      'workspace-status',
      [{ ...worktree, repoId: groupedRepo.id }],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      false,
      undefined,
      [group],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [makeFolderWorkspace('folder-1', group.id)]
    )

    const laneHeader = rows.find(
      (row) => row.type === 'header' && row.key.startsWith('workspace-status:')
    )
    if (laneHeader?.type !== 'header') {
      throw new Error('no status lane header')
    }
    expect([...(laneHeader.countedWorkspaceIds ?? [])].sort()).toEqual([FOLDER_1_KEY, key('wt-1')])
    // worktreeIds stays worktrees only: host sections read it to split a lane.
    expect(laneHeader.worktreeIds).toEqual(['wt-1'])
  })
})
