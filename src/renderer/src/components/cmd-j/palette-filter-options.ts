import { isWorktreeRetiredByRemoval } from '../../../../shared/worktree/removal/removal-visibility'
import {
  getRepoDisplayLabelKey,
  getRepoDisplayLabelsByPath
} from '../../../../shared/repository/appearance/repo-display-labels'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project/project-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { withoutHiddenRepos } from '../../../../shared/project/catalog/hidden-projects'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildProjectGroupingIndex } from '../../../../shared/sidebar-list/sections/project-section-grouping'
import { buildProjectFilterEntries } from '../../../../shared/sidebar-list/sections/project-filter-entries'
import type { SidebarHostOption } from '../sidebar/worktree-list/controls/sidebar-host-options'
import { translateHostDisplayLabel } from '../../runtime/hosts/display/execution-host-label'
import {
  expandEquivalentExecutionHostIds,
  pickerExecutionHosts
} from '../../../../shared/execution-host/managed-orcad-execution-host'
import { buildPaletteFilterOptionSearchText } from './palette-filter-option-list'

export type PaletteFilterOption = {
  id: string
  label: string
  detail: string
  count: number
  /** Pre-lowercased label+detail so keystroke filtering never re-lowercases. */
  searchText: string
}

function toFilterOption({
  id,
  label,
  detail,
  count,
  searchText
}: {
  id: string
  label: string
  detail: string
  count: number
  searchText?: string
}): PaletteFilterOption {
  return {
    id,
    label,
    detail,
    count,
    searchText: buildPaletteFilterOptionSearchText(
      label,
      searchText ? `${detail} ${searchText}` : detail
    )
  }
}

export type PaletteFilterModel = {
  hosts: readonly PaletteFilterOption[]
  repositories: readonly PaletteFilterOption[]
  /** Repository IDs represented by each project row in the sidebar grouping. */
  repoIdsByProjectKey: ReadonlyMap<string, readonly string[]>
  /** Every execution host that owns a repository ID. */
  hostIdsByRepoId: ReadonlyMap<string, ReadonlySet<ExecutionHostId>>
  /** Same last-row-wins repository index used by the sidebar. */
  repoById: ReadonlyMap<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
  /** The focused runtime host, which host-less repos and worktrees inherit. */
  defaultHostId: ExecutionHostId
  /** Both ids of a merged SSH host, keyed by either; absent ids stand only for themselves. */
  equivalentHostIdsById?: ReadonlyMap<string, readonly ExecutionHostId[]>
}

function buildRepoHostIndex(
  repos: readonly Repo[],
  defaultHostId: ExecutionHostId
): Map<string, Set<ExecutionHostId>> {
  const hostIdsByRepoId = new Map<string, Set<ExecutionHostId>>()
  for (const repo of repos) {
    const hostIds = hostIdsByRepoId.get(repo.id) ?? new Set<ExecutionHostId>()
    hostIds.add(
      repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
    )
    hostIdsByRepoId.set(repo.id, hostIds)
  }
  return hostIdsByRepoId
}

export function resolveWorktreeFilterHostId(
  worktree: Pick<Worktree, 'repoId' | 'hostId'>,
  repoById: ReadonlyMap<string, Pick<Repo, 'connectionId' | 'executionHostId'>>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return getWorktreeExecutionHostId(worktree, repoById.get(worktree.repoId), defaultHostId)
}

export function buildPaletteFilterModel({
  repos,
  worktrees,
  hostOptions,
  projects,
  projectHostSetups,
  defaultHostId = LOCAL_EXECUTION_HOST_ID
}: {
  repos: readonly Repo[]
  worktrees: readonly Worktree[]
  hostOptions: readonly SidebarHostOption[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  defaultHostId?: ExecutionHostId
}): PaletteFilterModel {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const hostIdsByRepoId = buildRepoHostIndex(repos, defaultHostId)
  const repoIdsByProjectKey = new Map(
    buildProjectFilterEntries(
      [...repoById.values()],
      buildProjectGroupingIndex({ projects, projectHostSetups })
    ).map((entry) => [entry.key, entry.repoIds])
  )

  const worktreeCountByHostId = new Map<string, number>()
  const worktreeCountByRepoId = new Map<string, number>()
  for (const worktree of worktrees) {
    if (worktree.isArchived || isWorktreeRetiredByRemoval(worktree)) {
      continue
    }
    const hostId = resolveWorktreeFilterHostId(worktree, repoById, defaultHostId)
    worktreeCountByHostId.set(hostId, (worktreeCountByHostId.get(hostId) ?? 0) + 1)
    worktreeCountByRepoId.set(
      worktree.repoId,
      (worktreeCountByRepoId.get(worktree.repoId) ?? 0) + 1
    )
  }

  // Registry order (local first, then SSH/runtime) matches the sidebar host headers.
  const hostRows = pickerExecutionHosts(hostOptions)
  const hosts = hostRows.map((host) =>
    toFilterOption({
      id: host.id,
      label: translateHostDisplayLabel(host),
      searchText: host.label,
      detail: host.detail,
      count: [host.id, ...(host.aliasHostIds ?? [])].reduce(
        (count, hostId) => count + (worktreeCountByHostId.get(hostId) ?? 0),
        0
      )
    })
  )
  // Why keyed by both ids: a filter saved before a route flip names the id now merged away.
  const equivalentHostIdsById = new Map(
    hostOptions
      .filter((host) => host.aliasHostIds || host.mergedIntoHostId)
      .map((host) => [host.id, expandEquivalentExecutionHostIds(hostOptions, [host.id])] as const)
  )

  // Keep repository IDs aligned with the sidebar; project grouping remains a row concern.
  const repositoryLabels = getRepoDisplayLabelsByPath([...repoById.values()])
  const listedRepoIds = new Set(withoutHiddenRepos(repos).map((repo) => repo.id))
  const repositories = [...repoById.values()]
    .filter((repo) => listedRepoIds.has(repo.id))
    .map((repo) =>
      toFilterOption({
        id: repo.id,
        label: repositoryLabels.get(getRepoDisplayLabelKey(repo)) ?? repo.displayName,
        detail: repo.path,
        count: worktreeCountByRepoId.get(repo.id) ?? 0
      })
    )
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))

  return {
    hosts,
    repositories,
    repoIdsByProjectKey,
    hostIdsByRepoId,
    repoById,
    defaultHostId,
    equivalentHostIdsById
  }
}
