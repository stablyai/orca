import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  type ExecutionHostScope
} from './execution-host'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './types'

type NewWorkspaceDialogRepo = Pick<
  Repo,
  'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId'
>

export function getNewWorkspaceDialogEligibleRepos<T extends Pick<Repo, 'path'>>(
  repos: readonly T[]
): T[] {
  return repos.filter((repo) => Boolean(repo.path))
}

export function resolveNewWorkspaceDialogRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: {
  eligibleRepos: readonly NewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  // Why: every new-workspace dialog should seed the repo the same way. Mobile
  // mirrors this locally because Metro cannot bundle root shared runtime modules.
  const focusedHostRepo =
    focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE
      ? eligibleRepos.find((repo) => getRepoExecutionHostId(repo) === focusedHostScope)
      : undefined

  const resolvedRepo =
    (draftRepoId && eligibleRepos.find((repo) => repo.id === draftRepoId)) ||
    (initialRepoId && eligibleRepos.find((repo) => repo.id === initialRepoId)) ||
    (activeRepoId && eligibleRepos.find((repo) => repo.id === activeRepoId)) ||
    focusedHostRepo ||
    eligibleRepos[0]

  return resolvedRepo?.id ?? ''
}

export function resolveNewWorkspaceDialogGitRepoId(args: {
  eligibleRepos: readonly NewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string | null {
  const repoId = resolveNewWorkspaceDialogRepoId(args)
  const repo = repoId ? args.eligibleRepos.find((entry) => entry.id === repoId) : null
  return repo && isGitRepoKind(repo) ? repo.id : null
}
