import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostScope
} from './execution-host'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './repo-types'

type NewWorkspaceDialogRepo = Pick<
  Repo,
  'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId'
>

export function getNewWorkspaceDialogEligibleRepos<T extends Pick<Repo, 'path' | 'connectionId'>>(
  repos: readonly T[]
): T[] {
  // Runtime-owned SSH repos are hidden plumbing. Selecting them after VM creation seeds a recipe-less repo and hides Run on in the next create.
  return repos.filter((repo) => Boolean(repo.path) && !isRuntimeOwnedSshTargetId(repo.connectionId))
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
  // Share repo seeding across dialogs; mobile mirrors locally because Metro cannot bundle root runtime modules.
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
