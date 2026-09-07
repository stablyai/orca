import { getRepoDisplayLabelKey, getRepoDisplayLabelsByPath } from '@/lib/repo-display-labels'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProjectHeaderRevealTarget } from '../sidebar/worktree-list/grouping/project-grouping'
import type { ProjectGroupingModel } from '../sidebar/worktree-list/grouping/project-grouping'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
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
  grouping: ProjectGroupingModel
): Map<string, string[]> {
  const repoIdsByProjectKey = new Map<string, string[]>()
  for (const repo of repos) {
    const target = getProjectHeaderRevealTarget(repo.id, repoById, grouping)
    if (!target.repo) {
      continue
    }
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
  const repoIdsByProjectKey = buildRepoIdsByProjectKey([...repoById.values()], repoById, {
    projects,
    projectHostSetups
  })

  const worktreeCountByHostId = new Map<string, number>()
  const worktreeCountByRepoId = new Map<string, number>()
  for (const worktree of worktrees) {
    if (worktree.isArchived) {
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
  const hosts = hostOptions.map((host) =>
    toFilterOption({
      id: host.id,
      label: host.label,
      detail: host.detail,
      count: worktreeCountByHostId.get(host.id) ?? 0
    })
  )

  // Keep repository IDs aligned with the sidebar; project grouping remains a row concern.
  const repositoryLabels = getRepoDisplayLabelsByPath([...repoById.values()])
  const repositories = [...repoById.values()]
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
    defaultHostId
  }
}
