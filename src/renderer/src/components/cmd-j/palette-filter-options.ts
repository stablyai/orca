import {
  getRepoExecutionHostId,
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
  projects: readonly PaletteFilterOption[]
  /** A project row can span several repos (Project.sourceRepoIds), so selection resolves through this. */
  repoIdsByProjectKey: ReadonlyMap<string, readonly string[]>
  /** Only repos that carry a host stamp; absent means "inherit defaultHostId". */
  hostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  /** The focused runtime host, which host-less repos and worktrees inherit. */
  defaultHostId: ExecutionHostId
}

/**
 * Precomputes only the repos that actually carry a host stamp so the lookup miss
 * below stays equivalent to getWorktreeExecutionHostId's `defaultHostId` branch.
 * Collapsing host-less repos to `local` here would disagree with the sidebar
 * whenever a runtime environment is focused.
 */
function buildRepoHostIndex(repos: readonly Repo[]): Map<string, ExecutionHostId> {
  const hostIdByRepoId = new Map<string, ExecutionHostId>()
  for (const repo of repos) {
    if (repo.connectionId || repo.executionHostId) {
      hostIdByRepoId.set(repo.id, getRepoExecutionHostId(repo))
    }
  }
  return hostIdByRepoId
}

export function resolveWorktreeFilterHostId(
  worktree: Pick<Worktree, 'repoId' | 'hostId'>,
  hostIdByRepoId: ReadonlyMap<string, ExecutionHostId>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  // Why: same precedence as getWorktreeExecutionHostId without re-resolving the
  // repo per worktree — the repo host is precomputed once for the whole pass.
  return worktree.hostId ?? hostIdByRepoId.get(worktree.repoId) ?? defaultHostId
}

/** Repo-derived host for a project row, which owns no worktree of its own. */
export function resolveRepoFilterHostId(
  repoId: string,
  hostIdByRepoId: ReadonlyMap<string, ExecutionHostId>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return hostIdByRepoId.get(repoId) ?? defaultHostId
}

type ProjectRow = { key: string; label: string; repoIds: string[] }

function buildProjectRows(
  repos: readonly Repo[],
  repoMap: Map<string, Repo>,
  grouping: ProjectGroupingModel
): { rows: ProjectRow[]; keyByRepoId: Map<string, string> } {
  const rows = new Map<string, ProjectRow>()
  const keyByRepoId = new Map<string, string>()
  for (const repo of repos) {
    const target = getProjectHeaderRevealTarget(repo.id, repoMap, grouping)
    if (!target.repo) {
      continue
    }
    const existing = rows.get(target.key)
    if (existing) {
      existing.repoIds.push(repo.id)
    } else {
      rows.set(target.key, { key: target.key, label: target.label, repoIds: [repo.id] })
    }
    keyByRepoId.set(repo.id, target.key)
  }
  return { rows: [...rows.values()], keyByRepoId }
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
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const hostIdByRepoId = buildRepoHostIndex(repos)
  const { rows, keyByRepoId } = buildProjectRows(repos, repoMap, { projects, projectHostSetups })

  const worktreeCountByHostId = new Map<string, number>()
  const worktreeCountByProjectKey = new Map<string, number>()
  for (const worktree of worktrees) {
    if (worktree.isArchived) {
      continue
    }
    const hostId = resolveWorktreeFilterHostId(worktree, hostIdByRepoId, defaultHostId)
    worktreeCountByHostId.set(hostId, (worktreeCountByHostId.get(hostId) ?? 0) + 1)
    const projectKey = keyByRepoId.get(worktree.repoId)
    if (projectKey) {
      worktreeCountByProjectKey.set(
        projectKey,
        (worktreeCountByProjectKey.get(projectKey) ?? 0) + 1
      )
    }
  }

  // Why: options are gated on a live workspace count, not on configuration — an
  // option that can only ever yield an empty list is a trap, and it also keeps
  // stale selections self-healing through reconcilePaletteFilter.
  // Registry order (local first, then SSH/runtime) matches the sidebar host headers.
  const hosts = hostOptions
    .filter((host) => (worktreeCountByHostId.get(host.id) ?? 0) > 0)
    .map((host) =>
      toFilterOption({
        id: host.id,
        label: host.label,
        detail: host.detail,
        count: worktreeCountByHostId.get(host.id) ?? 0
      })
    )

  // Popularity first so a long project list surfaces busy workspaces without search.
  const projectOptions = rows
    .filter((row) => (worktreeCountByProjectKey.get(row.key) ?? 0) > 0)
    .map((row) =>
      toFilterOption({
        id: row.key,
        label: row.label,
        detail: '',
        count: worktreeCountByProjectKey.get(row.key) ?? 0
      })
    )
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))

  return {
    hosts,
    projects: projectOptions,
    repoIdsByProjectKey: new Map(rows.map((row) => [row.key, row.repoIds])),
    hostIdByRepoId,
    defaultHostId
  }
}
