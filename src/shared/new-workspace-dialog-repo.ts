import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostScope
} from './execution-host'
import { isGitRepoKind } from './repo-kind'
import { isRepoHidden } from './hidden-projects'
import type { Repo } from './repo-types'

type NewWorkspaceDialogRepo = Pick<
  Repo,
  'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId' | 'hiddenAt'
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
  // Share repo seeding across the desktop dialogs and mobile.
  // Explicit draft/initial targets may name a hidden project; implicit defaults never pick one.
  const listedRepos = eligibleRepos.filter((repo) => !isRepoHidden(repo))
  const focusedHostRepo =
    focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE
      ? listedRepos.find((repo) => getRepoExecutionHostId(repo) === focusedHostScope)
      : undefined

  const resolvedRepo =
    (draftRepoId && eligibleRepos.find((repo) => repo.id === draftRepoId)) ||
    (initialRepoId && eligibleRepos.find((repo) => repo.id === initialRepoId)) ||
    (activeRepoId && listedRepos.find((repo) => repo.id === activeRepoId)) ||
    focusedHostRepo ||
    listedRepos[0]

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
