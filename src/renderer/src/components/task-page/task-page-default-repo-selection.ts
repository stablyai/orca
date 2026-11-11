import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import type { ProjectGroupingSettings } from '../../../../shared/project-grouping'
import {
  buildRepoProjectGroupingIndex,
  getProjectGroupForRepo,
  type ProjectGroupingIndex
} from '../../../../shared/project-section-grouping'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  hasProjectRemoteIdentity,
  isProjectRemoteIdentityPending
} from '../../../../shared/project-host-setup-projection'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'

export type TaskProjectPickerGroup = {
  projectKey: string
  repo: Repo
  sources: Repo[]
  selectionKeys?: readonly string[]
}

// Keep unknown/offline identities eligible until probing proves no usable remote, so repos cannot vanish without explanation.
export function getTaskEligibleRepos(repos: readonly Repo[]): Repo[] {
  return repos.filter(
    (repo) =>
      isGitRepoKind(repo) &&
      (hasProjectRemoteIdentity(repo) || isProjectRemoteIdentityPending(repo))
  )
}

export function getDefaultTaskRepoSelection(
  repos: readonly Repo[],
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): Set<string> {
  const projectIndex = grouping ?? buildRepoProjectGroupingIndex(repos, settings)
  const selectedByProject = new Map<string, Repo>()
  for (const repo of repos) {
    const projectKey = getProjectGroupForRepo(projectIndex, repo)?.key ?? `project:repo:${repo.id}`
    const current = selectedByProject.get(projectKey)
    if (!current || compareDefaultTaskRepoCandidate(repo, current) < 0) {
      selectedByProject.set(projectKey, repo)
    }
  }
  return new Set([...selectedByProject.values()].map(getRepoHostIdentity))
}

export function getTaskProjectPickerGroups(
  repos: readonly Repo[],
  preferredSelection: ReadonlySet<string> = new Set(),
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): TaskProjectPickerGroup[] {
  const projectIndex = grouping ?? buildRepoProjectGroupingIndex(repos, settings)
  const groupsByProject = new Map<string, TaskProjectPickerGroup>()
  for (const repo of repos) {
    const projectKey = getProjectGroupForRepo(projectIndex, repo)?.key ?? `project:repo:${repo.id}`
    const current = groupsByProject.get(projectKey)
    if (!current) {
      const group = getProjectGroupForRepo(projectIndex, repo)
      groupsByProject.set(projectKey, {
        projectKey,
        repo,
        sources: [repo],
        selectionKeys: group?.registrations.map((setup) => `${setup.hostId}\0${setup.repoId}`)
      })
      continue
    }
    current.sources.push(repo)
    if (compareTaskProjectPickerCandidate(repo, current.repo, preferredSelection) < 0) {
      current.repo = repo
    }
  }
  return [...groupsByProject.values()].map((group) => ({
    ...group,
    sources: [...group.sources].sort(compareDefaultTaskRepoCandidate)
  }))
}

export function normalizeTaskRepoSelection(
  repos: readonly Repo[],
  selection: ReadonlySet<string>,
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): Set<string> {
  const projectIndex = grouping ?? buildRepoProjectGroupingIndex(repos, settings)
  const selectedByProject = new Map<string, Repo>()
  const selectedIds = new Set(selection)
  const exactGroups = new Set<string>()
  for (const token of selection) {
    const group = projectIndex.groupByRepoHost.get(token)
    if (group) {
      exactGroups.add(group.key)
    }
  }
  for (const repo of repos) {
    if (!selectedIds.has(getRepoHostIdentity(repo)) && !selectedIds.has(repo.id)) {
      continue
    }
    const projectKey = getProjectGroupForRepo(projectIndex, repo)?.key ?? `project:repo:${repo.id}`
    if (exactGroups.has(projectKey) && !selectedIds.has(getRepoHostIdentity(repo))) {
      continue
    }
    const current = selectedByProject.get(projectKey)
    if (!current || compareTaskProjectPickerCandidate(repo, current, selection) < 0) {
      selectedByProject.set(projectKey, repo)
    }
  }
  if (selectedByProject.size === 0 && ![...selection].some((token) => token.includes('\0'))) {
    return getDefaultTaskRepoSelection(repos, settings, projectIndex)
  }
  const known = new Set<string>(repos.map(getRepoHostIdentity))
  return new Set([
    ...[...selection].filter((token) => token.includes('\0') && !known.has(token)),
    ...[...selectedByProject.values()].map(getRepoHostIdentity)
  ])
}

/** Resolve once per collection, before provider dispatch; raw saved choices keep their default ranking. */
export function resolveTaskSelectedRepos(
  repos: readonly Repo[],
  selection: ReadonlySet<string>,
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): Repo[] {
  const normalized = normalizeTaskRepoSelection(repos, selection, settings, grouping)
  return repos.filter((repo) => normalized.has(getRepoHostIdentity(repo)))
}

function compareTaskProjectPickerCandidate(
  a: Repo,
  b: Repo,
  preferredSelection: ReadonlySet<string>
): number {
  const aExact = preferredSelection.has(getRepoHostIdentity(a))
  const bExact = preferredSelection.has(getRepoHostIdentity(b))
  if (aExact !== bExact) {
    return aExact ? -1 : 1
  }
  const aPreferred = preferredSelection.has(a.id)
  const bPreferred = preferredSelection.has(b.id)
  if (aPreferred !== bPreferred) {
    return aPreferred ? -1 : 1
  }
  return compareDefaultTaskRepoCandidate(a, b)
}

function compareDefaultTaskRepoCandidate(a: Repo, b: Repo): number {
  // Prefer local checkout among host twins to avoid unexpected remote auth/network work on first load.
  const aLocal = getRepoExecutionHostId(a) === LOCAL_EXECUTION_HOST_ID
  const bLocal = getRepoExecutionHostId(b) === LOCAL_EXECUTION_HOST_ID
  if (aLocal !== bLocal) {
    return aLocal ? -1 : 1
  }
  return (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id)
}
