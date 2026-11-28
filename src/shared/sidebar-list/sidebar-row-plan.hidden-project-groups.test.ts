import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host/execution-host'
import { withoutHiddenProjectGroups } from '../project/catalog/hidden-projects'
import type { ProjectGroup } from '../project/groups/project-group-types'
import type { Repo } from '../repository/repo-types'
import { planSidebarRows } from './sidebar-row-plan'

function group(id: string, parentGroupId: string | null = null, tabOrder = 0): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function repo(id: string, projectGroupId: string, hidden = false): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#999999',
    addedAt: 1,
    projectGroupId,
    ...(hidden ? { hiddenAt: 1 } : {})
  }
}

function projectGroupHeaders(projectGroups: ProjectGroup[], repos: Repo[]): string[] {
  const rows = planSidebarRows({
    groupBy: 'repo',
    sortBy: 'manual',
    worktrees: [],
    repoMap: new Map(repos.map((entry) => [entry.id, entry])),
    prGroupOf: () => 'done',
    workspaceStatuses: [],
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(),
    nestLineage: false,
    projectGroups,
    repos,
    // A listed project without workspaces shows as a placeholder header; a hidden one never does.
    placeholderRepoIds: new Set(repos.filter((entry) => !entry.hiddenAt).map((entry) => entry.id)),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set())
  return rows.flatMap((row) =>
    row.type === 'header' && row.projectGroup?.id ? [row.projectGroup.id] : []
  )
}

function keptGroupIds(
  projectGroups: ProjectGroup[],
  repos: Repo[],
  folderGroupIds: string[] = []
): string[] {
  const folderWorkspaces = folderGroupIds.map((projectGroupId) => ({ projectGroupId }))
  return withoutHiddenProjectGroups({ projectGroups, repos, folderWorkspaces }).map((g) => g.id)
}

describe('project groups whose projects are all hidden', () => {
  it('omits the group when every project in it is hidden, and keeps the others', () => {
    const groups = [
      group('all-hidden', null, 0),
      group('one-listed', null, 1),
      group('new', null, 2)
    ]
    const repos = [
      repo('a', 'all-hidden', true),
      repo('b', 'all-hidden', true),
      repo('c', 'one-listed', true),
      repo('d', 'one-listed')
    ]

    expect(projectGroupHeaders(groups, repos)).toEqual(['one-listed', 'new'])
  })

  it('shows the group again, in its place, once one project is unhidden', () => {
    const groups = [group('first', null, 0), group('second', null, 1)]

    expect(projectGroupHeaders(groups, [repo('a', 'first'), repo('b', 'second', true)])).toEqual([
      'first'
    ])
    expect(projectGroupHeaders(groups, [repo('a', 'first'), repo('b', 'second')])).toEqual([
      'first',
      'second'
    ])
  })

  it('judges a nested group by its whole subtree', () => {
    const groups = [group('parent'), group('child', 'parent'), group('new-child', 'other')]
    const hiddenParent = repo('a', 'parent', true)

    expect(keptGroupIds(groups, [hiddenParent, repo('b', 'child')])).toEqual([
      'parent',
      'child',
      'new-child'
    ])
    expect(keptGroupIds(groups, [hiddenParent, repo('b', 'child', true)])).toEqual(['new-child'])
    // A just-created child keeps its parent, so it is not promoted to the root.
    expect(keptGroupIds([group('parent'), group('empty', 'parent')], [hiddenParent])).toEqual([
      'parent',
      'empty'
    ])
  })

  it('keeps a group that still lists a folder workspace', () => {
    expect(keptGroupIds([group('folders')], [repo('a', 'folders', true)], ['folders'])).toEqual([
      'folders'
    ])
  })
})
