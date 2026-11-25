import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../execution-host/execution-host'
import {
  getProjectIdentityKey,
  hasProjectRemoteIdentity,
  isProjectRemoteIdentityPending
} from '../project/host-setup/project-host-setup-projection'
import { isGitRepoKind } from '../repository/repo-kind'
import type { Repo } from '../repository/repo-types'

/** The repo fields task-source selection reads; desktop and phone both pass their repo rows. */
export type TaskRepo = Pick<Repo, 'id'> &
  Partial<
    Pick<
      Repo,
      | 'kind'
      | 'upstream'
      | 'repoIcon'
      | 'gitRemoteIdentity'
      | 'connectionId'
      | 'executionHostId'
      | 'addedAt'
    >
  >

export type TaskProjectPickerGroup<T extends TaskRepo = Repo> = {
  projectKey: string
  repo: T
  sources: T[]
}

// Keep unknown/offline identities eligible until probing proves no usable remote, so repos cannot vanish without explanation.
export function getTaskEligibleRepos<T extends TaskRepo>(repos: readonly T[]): T[] {
  return repos.filter(
    (repo) =>
      isGitRepoKind(repo) &&
      (hasProjectRemoteIdentity(repo) || isProjectRemoteIdentityPending(repo))
  )
}

export function getDefaultTaskRepoSelection(repos: readonly TaskRepo[]): Set<string> {
  const selectedByProject = new Map<string, TaskRepo>()
  for (const repo of repos) {
    const projectKey = getTaskRepoProjectKey(repo)
    const current = selectedByProject.get(projectKey)
    if (!current || compareDefaultTaskRepoCandidate(repo, current) < 0) {
      selectedByProject.set(projectKey, repo)
    }
  }
  return new Set([...selectedByProject.values()].map((repo) => repo.id))
}

export function getTaskProjectPickerGroups<T extends TaskRepo>(
  repos: readonly T[],
  preferredSelection: ReadonlySet<string> = new Set()
): TaskProjectPickerGroup<T>[] {
  const groupsByProject = new Map<string, TaskProjectPickerGroup<T>>()
  for (const repo of repos) {
    const projectKey = getTaskRepoProjectKey(repo)
    const current = groupsByProject.get(projectKey)
    if (!current) {
      groupsByProject.set(projectKey, { projectKey, repo, sources: [repo] })
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
  repos: readonly TaskRepo[],
  selection: ReadonlySet<string>
): Set<string> {
  const selectedByProject = new Map<string, TaskRepo>()
  const selectedIds = new Set(selection)
  for (const repo of repos) {
    if (!selectedIds.has(repo.id)) {
      continue
    }
    const projectKey = getTaskRepoProjectKey(repo)
    const current = selectedByProject.get(projectKey)
    if (!current || compareDefaultTaskRepoCandidate(repo, current) < 0) {
      selectedByProject.set(projectKey, repo)
    }
  }
  if (selectedByProject.size === 0) {
    return getDefaultTaskRepoSelection(repos)
  }
  return new Set([...selectedByProject.values()].map((repo) => repo.id))
}

export function getTaskRepoProjectKey(repo: TaskRepo): string {
  return getProjectIdentityKey(repo)
}

function compareTaskProjectPickerCandidate(
  a: TaskRepo,
  b: TaskRepo,
  preferredSelection: ReadonlySet<string>
): number {
  const aPreferred = preferredSelection.has(a.id)
  const bPreferred = preferredSelection.has(b.id)
  if (aPreferred !== bPreferred) {
    return aPreferred ? -1 : 1
  }
  return compareDefaultTaskRepoCandidate(a, b)
}

function compareDefaultTaskRepoCandidate(a: TaskRepo, b: TaskRepo): number {
  // Prefer local checkout among host twins to avoid unexpected remote auth/network work on first load.
  const aLocal = getRepoExecutionHostId(a) === LOCAL_EXECUTION_HOST_ID
  const bLocal = getRepoExecutionHostId(b) === LOCAL_EXECUTION_HOST_ID
  if (aLocal !== bLocal) {
    return aLocal ? -1 : 1
  }
  return (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id)
}
