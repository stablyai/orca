import type { ProjectSectionModel } from '../../../../shared/project-section-grouping'

import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import {
  type HostSectionRow,
  type HostSectionOption,
  addHostSectionRows
} from '../../../../shared/sidebar-list/host-section-rows'

import {
  type SidebarRowPlanInputs,
  planSidebarRows
} from '../../../../shared/sidebar-list/sidebar-row-plan'
import { createHostScopedRepoOf } from '../../../../shared/sidebar-list/sidebar-feed-index'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import {
  repo,
  remoteRepo,
  worktree,
  remoteWorktree,
  project,
  projectHostSetups
} from './worktree-list-groups-test-fixtures'
export const hosts: HostSectionOption[] = [
  { id: 'local', kind: 'local', label: 'Local Mac', detail: '', health: 'local' },
  { id: 'ssh:gpu-vm', kind: 'ssh', label: 'Builder', detail: '', health: 'available' }
]

export const otherRepo: Repo = {
  ...repo,
  id: 'repo-other',
  path: '/tmp/other',
  displayName: 'other'
}
export const otherWorktree: Worktree = {
  ...worktree,
  id: 'wt-other',
  repoId: otherRepo.id,
  path: '/tmp/other-feature'
}

export function hostSectionRows(collapsedGroups: Set<string>): HostSectionRow[] {
  const worktrees = [worktree, otherWorktree, remoteWorktree]
  const rows = planSidebarRows({
    groupBy: 'repo',
    worktrees,
    repoMap: new Map([repo, otherRepo, remoteRepo].map((entry) => [entry.id, entry])),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    repoOrder: new Map([
      [repo.id, 0],
      [otherRepo.id, 1],
      [remoteRepo.id, 2]
    ]),
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    projectGrouping: { projects: [project], projectHostSetups },
    folderWorkspaces: [],
    hostLabelById: new Map(hosts.map((host) => [host.id, host.label])),
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(collapsedGroups)
  return addHostSectionRows({
    rows,
    hostOptions: hosts,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: hosts.map((host) => host.id),
    defaultHostId: 'local',
    localHostLabel: 'Local Mac',
    preferProjectGrouping: true
  })
}

export function groupingFor(
  entries: readonly Repo[],
  mode: 'repository' | 'host' | 'folder' = 'repository'
): ProjectSectionModel {
  return {
    projects: [project],
    projectHostSetups: entries.map((entry) => ({
      ...projectHostSetups[0],
      id: `${getRepoExecutionHostId(entry)}:${entry.id}`,
      repoId: entry.id,
      hostId: getRepoExecutionHostId(entry),
      path: entry.path,
      displayName: entry.displayName,
      connectionId: entry.connectionId,
      executionHostId: entry.executionHostId
    })),
    settings: { projectGroupingMode: mode }
  }
}
export function prepareSections(
  entries: readonly Repo[],
  rows: Worktree[],
  extra: Partial<SidebarRowPlanInputs> = {}
) {
  const repoMap = extra.repoMap ?? new Map(entries.map((entry) => [entry.id, entry]))
  return planSidebarRows({
    groupBy: 'repo',
    worktrees: rows,
    repos: entries,
    repoMap,
    repoOfWorktree: createHostScopedRepoOf(entries, repoMap),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(rows.map((row) => [row.id, row])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: [],
    ...extra
  })
}
export function sectionHosts(
  rows: Parameters<typeof addHostSectionRows>[0]['rows'],
  options = hosts
) {
  return addHostSectionRows({
    rows,
    hostOptions: options,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: options.map((host) => host.id),
    defaultHostId: 'local',
    localHostLabel: 'Local Mac',
    preferProjectGrouping: true
  })
}
