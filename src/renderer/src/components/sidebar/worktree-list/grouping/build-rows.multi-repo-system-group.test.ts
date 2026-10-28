import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows.test-fixture'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

function group(id: string, name: string, tabOrder: number): ProjectGroup {
  return {
    id,
    name,
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

function folderWorkspace(id: string, projectGroupId: string, multiRepo: boolean): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/tmp/${id}`,
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
    ...(multiRepo
      ? {
          multiRepo: {
            version: 1 as const,
            executionHostId: 'local' as const,
            rootOwnedByOrca: true,
            members: []
          }
        }
      : {})
  }
}

function rowsFor(projectGroups: ProjectGroup[], folderWorkspaces: FolderWorkspace[]): Row[] {
  return buildRows(
    'repo',
    [worktree],
    new Map([[repo.id, repo]]),
    null,
    new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    new Map([[worktree.id, worktree]]),
    false,
    undefined,
    projectGroups,
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    folderWorkspaces
  )
}

function groupHeaders(rows: Row[]) {
  return rows.flatMap((row) =>
    row.type === 'header' && row.projectGroup && 'createdFrom' in row.projectGroup
      ? [{ name: row.projectGroup.name, system: row.multiRepoSystemGroup === true }]
      : []
  )
}

describe('the multi-repo Workspaces section', () => {
  it('sorts first and is flagged once it holds a multi-repo workspace', () => {
    const rows = rowsFor(
      [group('mine', 'Mine', 0), group('sys', 'Workspaces', 5)],
      [folderWorkspace('plain', 'mine', false), folderWorkspace('multi', 'sys', true)]
    )
    expect(groupHeaders(rows)).toEqual([
      { name: 'Workspaces', system: true },
      { name: 'Mine', system: false }
    ])
  })

  it('leaves a user group that merely shares the name alone', () => {
    const rows = rowsFor(
      [group('mine', 'Mine', 0), group('same-name', 'Workspaces', 5)],
      [folderWorkspace('plain', 'same-name', false)]
    )
    expect(groupHeaders(rows)).toEqual([
      { name: 'Mine', system: false },
      { name: 'Workspaces', system: false }
    ])
  })
})
