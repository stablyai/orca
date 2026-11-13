import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import { createHostScopedRepoOf } from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { expandEquivalentExecutionHostIds } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { buildSidebarHostOptions, buildSidebarHostScopeOptions } from './sidebar-host-options'

// English defaults with {{slots}} filled, like i18next with no catalog.
const t = (_key: string, fallback: string, params?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_slot, name: string) => String(params?.[name] ?? ''))

// Two Orca Cloud sandboxes (one running, one asleep) and this computer, all for one project.
const cloudA: Repo = { ...repo, path: '/workspace/hello', executionHostId: 'runtime:env-a' }
const cloudB: Repo = { ...repo, path: '/workspace/hello', executionHostId: 'runtime:env-b' }
const environments = [
  { id: 'env-a', name: 'hello sandbox aaaaaaaa', source: 'ephemeral-vm' as const },
  { id: 'env-b', name: 'hello sandbox bbbbbbbb', source: 'ephemeral-vm' as const }
]

function hostOptions() {
  return buildSidebarHostOptions(
    {
      repos: [repo, cloudA, cloudB],
      sshTargetLabels: new Map(),
      settings: null,
      runtimeEnvironments: environments,
      ephemeralVmHosts: [
        { runtimeEnvironmentId: 'env-a', status: 'running', waking: false },
        { runtimeEnvironmentId: 'env-b', status: 'suspended', waking: false }
      ]
    },
    t
  )
}

// The local host's label comes from process.platform ("Local Mac" on macOS, "Local Linux" on Linux): read it from the
// built options instead of hard-coding it, so the test passes on any OS (it failed on the Linux premerge lane).
const localLabel = (): string =>
  hostOptions().find((host) => host.id === 'local')?.label ?? 'Local Mac'

const worktrees: Worktree[] = [
  { ...worktree, id: 'wt-local', displayName: 'local work' },
  { ...worktree, id: 'wt-a', hostId: 'runtime:env-a', displayName: 'fix login' },
  { ...worktree, id: 'wt-b', hostId: 'runtime:env-b', displayName: 'docs refresh' }
]

function groupedByHost() {
  const hosts = hostOptions()
  const repoMap = new Map([[repo.id, repo]])
  const rows = planSidebarRows({
    groupBy: 'repo',
    sortBy: 'smart',
    worktrees,
    repoMap,
    repoOfWorktree: createHostScopedRepoOf([repo, cloudA, cloudB], repoMap),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set())
  const everyHost: ExecutionHostId[] = expandEquivalentExecutionHostIds(
    hosts,
    hosts.map((host) => host.id)
  )
  return addHostSectionRows({
    rows,
    hostOptions: hosts,
    workspaceHostScope: 'all',
    // The Hosts filter with every host checked: the view that draws host headers.
    visibleWorkspaceHostIds: everyHost,
    defaultHostId: 'local',
    localHostLabel: localLabel(),
    preferProjectGrouping: true
  })
}

describe('Orca Cloud is one host (RA-2)', () => {
  it('collapses two sandboxes into one "Orca Cloud" section with an aggregate state', () => {
    const rows = groupedByHost()
    const hostHeaders = rows.filter((row) => row.type === 'host-header')
    expect(hostHeaders.map((row) => row.label)).toEqual([localLabel(), 'Orca Cloud'])
    const cloud = hostHeaders[1]
    expect(cloud?.count).toBe(2)
    // Never one sandbox's state.
    expect(cloud?.vmState).toBeUndefined()
    expect(cloud?.detail).toBe('1 running · 1 asleep')
    // One project header under Orca Cloud, holding both sandboxes' workspaces.
    const cloudIndex = rows.indexOf(cloud!)
    const underCloud = rows.slice(cloudIndex + 1)
    expect(underCloud.filter((row) => row.type === 'header')).toHaveLength(1)
    expect(
      underCloud.flatMap((row) => (row.type === 'item' ? [row.worktree.id] : [])).sort()
    ).toEqual(['wt-a', 'wt-b'])
  })

  it('lists Orca Cloud once in the Hosts filter, and checking it selects every sandbox', () => {
    const hosts = hostOptions()
    const scope = buildSidebarHostScopeOptions(hosts, t)
    expect(scope.map((option) => option.label)).toEqual(['All hosts', localLabel(), 'Orca Cloud'])
    const cloudRow = scope.find((option) => option.label === 'Orca Cloud')
    expect(cloudRow?.detail).toBe('1 running · 1 asleep')
    expect(
      expandEquivalentExecutionHostIds(hosts, [
        hosts.find((host) => host.id === cloudRow?.id)!.id
      ]).sort()
    ).toEqual(['runtime:env-a', 'runtime:env-b'])
  })

  it('says "Asleep" when every sandbox sleeps, never "Suspended"', () => {
    const hosts = buildSidebarHostOptions(
      {
        repos: [repo, cloudA, cloudB],
        sshTargetLabels: new Map(),
        settings: null,
        runtimeEnvironments: environments,
        ephemeralVmHosts: [
          { runtimeEnvironmentId: 'env-a', status: 'suspended', waking: false },
          { runtimeEnvironmentId: 'env-b', status: 'suspended', waking: false }
        ]
      },
      t
    )
    const cloud = hosts.find((host) => host.orcaCloud)
    expect(cloud?.detail).toBe('Asleep')
    expect(cloud?.vmState).toBeUndefined()
  })
})
