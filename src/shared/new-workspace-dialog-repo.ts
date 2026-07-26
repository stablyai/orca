import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostScope
} from './execution-host'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './types'

type NewWorkspaceDialogRepo = Pick<
  Repo,
  'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId'
>

type NewWorkspaceDialogRepoSelectionInput<T extends NewWorkspaceDialogRepo> = {
  eligibleRepos: readonly T[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}

export function getNewWorkspaceDialogEligibleRepos<T extends Pick<Repo, 'path' | 'connectionId'>>(
  repos: readonly T[]
): T[] {
  // Why: a runtime-owned (per-workspace-env) SSH repo is hidden plumbing, not a real project. If it
  // were selectable here, creating an ephemeral VM would seed the composer to that repo — which has
  // no recipes — hiding the "Run on" picker entirely on the next create. Exclude it like every other
  // user-facing surface does.
  return repos.filter((repo) => Boolean(repo.path) && !isRuntimeOwnedSshTargetId(repo.connectionId))
}

export function resolveNewWorkspaceDialogRepo<T extends NewWorkspaceDialogRepo>({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: NewWorkspaceDialogRepoSelectionInput<T>): T | null {
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

  return resolvedRepo ?? null
}

export function resolveNewWorkspaceDialogRepoId(
  input: NewWorkspaceDialogRepoSelectionInput<NewWorkspaceDialogRepo>
): string {
  return resolveNewWorkspaceDialogRepo(input)?.id ?? ''
}

export function resolveNewWorkspaceDialogGitRepoId(args: {
  eligibleRepos: readonly NewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string | null {
  const repo = resolveNewWorkspaceDialogRepo(args)
  return repo && isGitRepoKind(repo) ? repo.id : null
}
