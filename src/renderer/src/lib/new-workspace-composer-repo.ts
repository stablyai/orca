import { isRuntimeOwnedSshTargetId, type ExecutionHostScope } from '../../../shared/execution-host'
import {
  getNewWorkspaceDialogEligibleRepos,
  resolveNewWorkspaceDialogGitRepoId,
  resolveNewWorkspaceDialogRepoId
} from '../../../shared/new-workspace-dialog-repo'
import { getProjectIdentityKey } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'

export function getComposerEligibleRepos(repos: readonly Repo[]): Repo[] {
  return getNewWorkspaceDialogEligibleRepos(repos)
}

/** Map hidden per-workspace-runtime repos to their visible project sibling so composer selection cannot fall back to another project. */
export function resolveComposerActiveRepoId(
  repos: readonly Repo[],
  eligibleRepos: readonly Repo[],
  activeRepoId: string | null | undefined
): string | null {
  if (!activeRepoId) {
    return activeRepoId ?? null
  }
  const activeRepo = repos.find((repo) => repo.id === activeRepoId)
  if (!activeRepo || !isRuntimeOwnedSshTargetId(activeRepo.connectionId)) {
    return activeRepoId
  }
  const projectKey = getProjectIdentityKey(activeRepo)
  const sibling = eligibleRepos.find((repo) => getProjectIdentityKey(repo) === projectKey)
  return sibling?.id ?? activeRepoId
}

export function resolveComposerRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  return resolveNewWorkspaceDialogRepoId({
    eligibleRepos,
    draftRepoId,
    initialRepoId,
    activeRepoId,
    focusedHostScope
  })
}

export function resolveComposerGitRepoId(args: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string | null {
  return resolveNewWorkspaceDialogGitRepoId(args)
}
