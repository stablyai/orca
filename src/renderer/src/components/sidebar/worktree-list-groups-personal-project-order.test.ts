import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { planSidebarRows } from '../../../../shared/sidebar-list/sidebar-row-plan'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import { describe, expect, it } from 'vitest'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import type { ProjectGroup } from '../../../../shared/project-group-types'
describe('personal project order through sidebar rows', () => {
  const alpha = {
    ...repo,
    id: 'alpha',
    path: '/alpha',
    displayName: 'Project 2',
    executionHostId: 'local' as const
  }
  const beta = {
    ...repo,
    id: 'beta',
    path: '/beta',
    displayName: 'Project 10',
    executionHostId: 'local' as const
  }
  const projection = projectHostSetupProjectionFromRepos([alpha, beta])
  const personalProjectOrder = {
    projects: {
      '["local","local","repo:alpha"]': { lastOpenedAt: 300, openCount: 1 },
      '["local","local","repo:beta"]': { lastOpenedAt: 100, openCount: 5 }
    },
    settledOperations: []
  }
  function headers(
    mode: 'manual' | 'recent' | 'name' | 'frequent',
    pinned = false,
    grouped = false
  ) {
    const repos = [beta, alpha].map((entry, index) => ({
      ...entry,
      projectGroupId: grouped ? 'g' : null,
      projectGroupOrder: index
    }))
    const groups: ProjectGroup[] = grouped
      ? [
          {
            id: 'g',
            name: 'Group',
            parentPath: null,
            parentGroupId: null,
            createdFrom: 'manual',
            tabOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: 0,
            updatedAt: 0
          }
        ]
      : []
    const rows = planSidebarRows({
      groupBy: 'repo',
      worktrees: [
        { ...worktree, id: 'a', repoId: alpha.id, lastActivityAt: 1 },
        { ...worktree, id: 'b', repoId: beta.id, lastActivityAt: 9999 }
      ],
      repoMap: new Map(repos.map((entry) => [entry.id, entry])),
      prGroupOf: () => 'in-progress',
      repoOrder: new Map([
        ['beta', 0],
        ['alpha', 1]
      ]),
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      projectOrderBy: mode,
      lineageById: {},
      worktreeMap: new Map(),
      nestLineage: false,
      projectGroups: groups,
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      projectGrouping: {
        projects: projection.projects,
        projectHostSetups: projection.setups,
        personalProjectOrder: {
          ...personalProjectOrder,
          projects: {
            ...personalProjectOrder.projects,
            '["local","local","repo:alpha"]': {
              ...personalProjectOrder.projects['["local","local","repo:alpha"]'],
              pinned
            }
          }
        }
      },
      folderWorkspaces: [],
      defaultHostId: 'local',
      pinnedDisplayPolicy: 'single-location',
      filterRepoIds: []
    }).render(new Set())
    return rows.flatMap((row) => (row.type === 'header' && row.repo ? [row.repo.id] : []))
  }
  it.each([false, true])(
    'uses personal recency despite newer agent activity (grouped=%s)',
    (grouped) => {
      expect(headers('recent', false, grouped)).toEqual(['alpha', 'beta'])
      expect(headers('frequent', false, grouped)).toEqual(['beta', 'alpha'])
      expect(headers('name', false, grouped)).toEqual(['alpha', 'beta'])
      expect(headers('manual', false, grouped)).toEqual(['beta', 'alpha'])
    }
  )
  it.each(['manual', 'recent', 'name', 'frequent'] as const)(
    'pins independently in %s and restores normal order on unpin',
    (mode) => {
      expect(headers(mode, true)).toEqual(['alpha', 'beta'])
      expect(headers(mode, true, true)).toEqual(['alpha', 'beta'])
      expect(headers('manual')).toEqual(['beta', 'alpha'])
    }
  )
})

it('keeps host-local same-ID folder projects and their pins on their actual owners', () => {
  const local = {
    ...repo,
    id: 'same',
    path: '/same',
    displayName: 'Local folder',
    kind: 'folder' as const,
    executionHostId: 'local' as const
  }
  const remote = {
    ...local,
    path: '/remote',
    displayName: 'Remote folder',
    executionHostId: 'runtime:server' as const
  }
  const projection = projectHostSetupProjectionFromRepos([local, remote])
  const rows = [
    { ...worktree, id: 'same::/w', repoId: 'same', hostId: 'local' as const },
    { ...worktree, id: 'same::/w', repoId: 'same', hostId: 'runtime:server' as const }
  ]
  const plan = planSidebarRows({
    groupBy: 'repo',
    worktrees: rows,
    repoMap: new Map([['same', local]]),
    repoOfWorktree: (row) => (row.hostId === 'local' ? local : remote),
    prGroupOf: () => 'in-progress',
    repoOrder: new Map([['same', 0]]),
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    projectGrouping: {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      personalProjectOrder: {
        projects: { '["runtime:server","runtime:server","repo:same"]': { pinned: true } },
        settledOperations: []
      }
    },
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  })
  for (const occurrence of plan.occurrencePlan.preferredByIdentity.values()) {
    expect(occurrence.owningSectionKey).toBe(occurrence.sectionKey)
  }
  const headers = plan.render(new Set()).filter((row) => row.type === 'header' && row.repo)
  expect(headers).toHaveLength(2)
  expect(
    headers.flatMap((row) => (row.type === 'header' ? [row.repo?.executionHostId] : []))
  ).toEqual(['runtime:server', 'local'])
})
