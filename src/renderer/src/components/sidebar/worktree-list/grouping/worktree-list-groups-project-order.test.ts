import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows.test-fixture'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'

describe('buildRows project grouping order', () => {
  it('interleaves ranked root groups with projects while retaining unranked legacy groups first', () => {
    const group = (id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
      id,
      name: id,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1,
      ...overrides
    })
    const repos = [
      { ...repo, id: 'first', path: '/first', projectGroupOrder: 0 },
      { ...repo, id: 'last', path: '/last', projectGroupOrder: 2 },
      { ...repo, id: 'member', path: '/member', projectGroupId: 'middle' }
    ]
    const rows = planSidebarRows({
      groupBy: 'repo',
      sortBy: 'smart',
      projectOrderBy: 'manual',
      worktrees: repos.map((entry) => ({ ...worktree, id: entry.id, repoId: entry.id })),
      repoMap: new Map(repos.map((entry) => [entry.id, entry])),
      projectGroups: [group('middle', { rootProjectOrder: 1 }), group('legacy')],
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      prGroupOf: () => 'in-progress',
      lineageById: {},
      worktreeMap: new Map(),
      nestLineage: false,
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      folderWorkspaces: [],
      defaultHostId: 'local',
      filterRepoIds: [],
      pinnedDisplayPolicy: 'single-location'
    }).render(new Set())

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:legacy',
      'repo:first',
      'project-group:middle',
      'repo:member',
      'repo:last'
    ])
  })

  // A stale sibling precedes A’s fresh child to require max-child activity ranking.

  it('builds rows for a very large repo-group list', () => {
    const count = 130_000
    const repos = new Map<string, Repo>()
    const worktrees = Array.from({ length: count }, (_, index) => {
      const repoId = `repo-${index}`
      repos.set(repoId, { ...repo, id: repoId, displayName: `repo ${index}` })
      return { ...worktree, id: `wt-${index}`, repoId, displayName: `workspace ${index}` }
    })

    const rows = buildRows('repo', worktrees, repos, null, new Set())

    expect(rows).toHaveLength(count * 2)
    expect(rows[0]).toMatchObject({ type: 'header', key: 'repo:repo-0' })
    expect(rows.at(-1)).toMatchObject({ type: 'item', worktree: { id: 'wt-129999' } })
  })
})
