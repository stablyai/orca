import {
  getRepoDisplayLabelsByPath,
  getRepoDisplayLabelKey
} from '../../../../shared/repo-display-labels'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { GroupingSetup, ProjectGroupingSettings } from '../../../../shared/project-grouping'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  getProjectSectionRepoLookup,
  type ProjectGroupingIndex
} from '../../../../shared/project-section-grouping'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import {
  expandEquivalentExecutionHostIds,
  pickerExecutionHosts
} from '../../../../shared/managed-orcad-execution-host'
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
  count
}: {
  id: string
  label: string
  detail: string
  count: number
}): PaletteFilterOption {
  return {
    id,
    label,
    detail,
    count,
    searchText: buildPaletteFilterOptionSearchText(label, detail)
  }
}

export type PaletteFilterModel = {
  projectIndex?: ProjectGroupingIndex
  membersByProjectKey?: ReadonlyMap<string, readonly GroupingSetup[]>
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

function buildRepoIdsByProjectKey(
  repos: readonly Repo[],
  repoById: Map<string, Repo>,
  grouping: ProjectGroupingIndex
): Map<string, string[]> {
  const repoIdsByProjectKey = new Map<string, string[]>()
  const seen = new Set<string>()
  const repoByHost = getProjectSectionRepoLookup(repos)
  for (const repo of repos) {
    const target = getProjectGroupingForRepo(
      repo.id,
      repoById,
      grouping,
      getRepoExecutionHostId(repo),
      repoByHost
    )
    if (!target.repo) {
      continue
    }
    const membership = JSON.stringify([target.key, repo.id])
    if (seen.has(membership)) {
      continue
    }
    seen.add(membership)
    const repoIds = repoIdsByProjectKey.get(target.key)
    if (repoIds) {
      repoIds.push(repo.id)
    } else {
      repoIdsByProjectKey.set(target.key, [repo.id])
    }
  }
  return repoIdsByProjectKey
}

export function buildPaletteFilterModel({
  repos,
  worktrees,
  hostOptions,
  projects,
  projectHostSetups,
  settings,
  projectIndex,
  defaultHostId = LOCAL_EXECUTION_HOST_ID
}: {
  repos: readonly Repo[]
  worktrees: readonly Worktree[]
  hostOptions: readonly SidebarHostOption[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  settings?: ProjectGroupingSettings | null
  projectIndex?: ProjectGroupingIndex
  defaultHostId?: ExecutionHostId
}): PaletteFilterModel {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const hostIdsByRepoId = buildRepoHostIndex(repos, defaultHostId)
  const index = projectIndex ?? buildProjectGroupingIndex({ projects, projectHostSetups, settings })
  const repoIdsByProjectKey = buildRepoIdsByProjectKey(repos, repoById, index)

  const worktreeCountByHostId = new Map<string, number>()
  const worktreeCountByProjectKey = new Map<string, number>()
  const seenWorktrees = new Set<string>()
  for (const worktree of worktrees) {
    if (worktree.isArchived) {
      continue
    }
    const hostId = resolveWorktreeFilterHostId(worktree, repoById, defaultHostId)
    const identity = `${hostId}\0${worktree.path ? normalizeRuntimePathForComparison(worktree.path) : worktree.id}`
    if (seenWorktrees.has(identity)) {
      continue
    }
    seenWorktrees.add(identity)
    worktreeCountByHostId.set(hostId, (worktreeCountByHostId.get(hostId) ?? 0) + 1)
    const key =
      index.groupByRepoHost.get(getRepoHostIdentityForParts(worktree.repoId, hostId))?.key ??
      `repo:${worktree.repoId}`
    worktreeCountByProjectKey.set(key, (worktreeCountByProjectKey.get(key) ?? 0) + 1)
  }

  // Registry order (local first, then SSH/runtime) matches the sidebar host headers.
  const hostRows = pickerExecutionHosts(hostOptions)
  const hosts = hostRows.map((host) =>
    toFilterOption({
      id: host.id,
      label: host.label,
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

  const optionsByKey = new Map(
    index.groups.map((group) => [
      group.key,
      toFilterOption({
        id: group.key,
        label: group.label,
        detail: group.representative.path ?? '',
        count: worktreeCountByProjectKey.get(group.key) ?? 0
      })
    ])
  )
  const fallbackLabels = getRepoDisplayLabelsByPath(repos)
  const repoByHost = getProjectSectionRepoLookup(repos)
  for (const repo of repos) {
    const target = getProjectGroupingForRepo(
      repo.id,
      repoById,
      index,
      getRepoExecutionHostId(repo),
      repoByHost
    )
    if (!optionsByKey.has(target.key)) {
      optionsByKey.set(
        target.key,
        toFilterOption({
          id: target.key,
          label: fallbackLabels.get(getRepoDisplayLabelKey(repo)) ?? target.label,
          detail: repo.path,
          count: worktreeCountByProjectKey.get(target.key) ?? 0
        })
      )
    }
  }
  const repositories = [...optionsByKey.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
  )

  return {
    projectIndex: index,
    hosts,
    repositories,
    repoIdsByProjectKey,
    membersByProjectKey: new Map(index.groups.map((group) => [group.key, group.registrations])),
    hostIdsByRepoId,
    repoById,
    defaultHostId,
    equivalentHostIdsById
  }
}
