import { describe, expect, it } from 'vitest'
import { buildRows } from '../grouping/build-rows'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspace-worktree'
import { getWorktreeDragGroups } from './groups'
import {
  getFolderWorkspaceDragGroups,
  isFolderWorkspaceDragGroupKey
} from './folder-workspace-drag-groups'

function makeGroup(id: string, tabOrder: number): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/tmp/${id}`,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const GROUP_A = makeGroup('group-a', 0)
const GROUP_B = makeGroup('group-b', 1)
const GROUPED_REPO: Repo = { ...repo, projectGroupId: GROUP_A.id }

function makeFolderWorkspace(
  name: string,
  projectGroupId: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id: `fw-${name}`,
    projectGroupId,
    name,
    folderPath: `/tmp/${projectGroupId}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    workspaceStatus: 'in-progress',
    ...overrides
  }
}

function rowsFor(groupBy: WorktreeGroupBy, folderWorkspaces: FolderWorkspace[]) {
  return buildRows(
    groupBy,
    [worktree],
    new Map([[GROUPED_REPO.id, GROUPED_REPO]]),
    null,
    new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    new Map([[worktree.id, worktree]]),
    false,
    undefined,
    [GROUP_A, GROUP_B],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    folderWorkspaces,
    undefined,
    undefined,
    undefined,
    'name'
  )
}

describe('getFolderWorkspaceDragGroups', () => {
  it('groups each project group’s folder workspaces apart from worktrees', () => {
    const remote = makeFolderWorkspace('3_remote', GROUP_A.id, { connectionId: 'conn-1' })
    const rows = rowsFor('repo', [
      makeFolderWorkspace('1_a', GROUP_A.id),
      makeFolderWorkspace('2_a', GROUP_A.id),
      remote,
      makeFolderWorkspace('1_b', GROUP_B.id)
    ])

    const { groups, groupKeyByRowKey, groupIndexByRowKey } = getFolderWorkspaceDragGroups(rows)

    expect(groups.map((group) => group.worktreeIds)).toEqual([
      ['folder:fw-1_a', 'folder:fw-2_a', 'folder:fw-3_remote'],
      ['folder:fw-1_b']
    ])
    expect(groups.every((group) => isFolderWorkspaceDragGroupKey(group.key))).toBe(true)
    // Why: the row's pointer-down passes its host identity as the row key.
    const remoteRowKey = getFolderWorkspaceHostIdentity(remote)
    expect(groupKeyByRowKey.get(remoteRowKey)).toBe(groups[0]!.key)
    expect(groupIndexByRowKey.get(remoteRowKey)).toBe(2)
    // Worktree groups never pick up folder rows, so their manual-order neighbours stay put.
    expect(getWorktreeDragGroups(rows).flatMap((group) => group.worktreeIds)).toEqual([worktree.id])
  })

  it('splits a lane where project groups interleave into separate runs', () => {
    const rows = rowsFor('none', [
      makeFolderWorkspace('1_a', GROUP_A.id),
      makeFolderWorkspace('2_b', GROUP_B.id),
      makeFolderWorkspace('3_a', GROUP_A.id)
    ])

    const { groups } = getFolderWorkspaceDragGroups(rows)

    expect(groups.map((group) => group.worktreeIds)).toEqual([
      ['folder:fw-1_a'],
      ['folder:fw-2_b'],
      ['folder:fw-3_a']
    ])
    expect(new Set(groups.map((group) => group.key)).size).toBe(3)
  })
})
