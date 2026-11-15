import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId,
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
  activeWorkspaceHostId,
  focusedHostScope
}: {
  eligibleRepos: readonly NewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  activeWorkspaceHostId?: ExecutionHostId | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  // Share repo seeding across the desktop dialogs and mobile.
  // Explicit draft/initial targets may name a hidden project; implicit defaults never pick one.
  const listedRepos = eligibleRepos.filter((repo) => !isRepoHidden(repo))
  const activeHostRepo = activeWorkspaceHostId
    ? listedRepos.find((repo) => getRepoExecutionHostId(repo) === activeWorkspaceHostId)
    : undefined
  const focusedHostRepo =
    focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE
      ? listedRepos.find((repo) => getRepoExecutionHostId(repo) === focusedHostScope)
      : undefined
  // Repo order follows the sidebar; an unseeded dialog still defaults to Local (#41140).
  const localRepo = listedRepos.find(
    (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
  )

  const resolvedRepo =
    (draftRepoId && eligibleRepos.find((repo) => repo.id === draftRepoId)) ||
    (initialRepoId && eligibleRepos.find((repo) => repo.id === initialRepoId)) ||
    (activeRepoId && listedRepos.find((repo) => repo.id === activeRepoId)) ||
    activeHostRepo ||
    focusedHostRepo ||
    localRepo ||
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
