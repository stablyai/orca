import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { CLEARED_HOSTED_REVIEW_SELECTION_UPDATES } from '../../../../shared/worktree/hosted-review-links'
import {
  shouldApplyBranchMismatchedLinkedPRClear,
  shouldApplyDivergedLinkedPRClear
} from '../../../../shared/github/linked-pr-staleness'
import { getHostedReviewLinkMutationGeneration } from '../slices/worktrees/metadata/hosted-review-link-mutation'
import { tryRuntimeTargetForWorktreeOwner } from '../slices/worktrees/listing/worktree-owner-target'
import { hasUniqueIndexedRepositoryHost } from '@/lib/repository-owner-index'
import { resolveReviewRepository } from '@/lib/review-owner'
import { findWorktreeById, getWorktreeLookupIndex } from './worktree-refresh'

export type LinkedReviewClearScope = {
  repository: Repo
  workspace: Worktree
  linkMutationGeneration: number
}

export function captureLinkedReviewClearScope(
  state: AppState,
  worktreeId: string | undefined,
  repository: Repo | undefined
): LinkedReviewClearScope | undefined {
  if (
    !worktreeId ||
    !repository ||
    !hasUniqueIndexedRepositoryHost(state.repos, repository.id, getRepoExecutionHostId(repository))
  ) {
    return undefined
  }
  const workspace = findWorktreeById(state, worktreeId, getRepoExecutionHostId(repository))
  if (!workspace || !resolveReviewRepository(state.repos, workspace, repository)) {
    return undefined
  }
  // The metadata API cannot distinguish two rows with the same physical host.
  const copies = getWorktreeLookupIndex(state).byId.get(worktreeId)?.owners ?? []
  if (copies.filter((row) => row.hostId === workspace.hostId).length !== 1) {
    return undefined
  }
  if (
    !tryRuntimeTargetForWorktreeOwner(
      state,
      workspace.id,
      workspace.hostId ?? getRepoExecutionHostId(repository)
    )
  ) {
    return undefined
  }
  return {
    repository,
    workspace,
    linkMutationGeneration: getHostedReviewLinkMutationGeneration(worktreeId)
  }
}

function sameWorkspace(original: Worktree, current: Worktree): boolean {
  if (original === current) {
    return true
  }
  const occupant = original.identity?.key ?? original.instanceId
  return (
    Boolean(occupant) &&
    occupant === (current.identity?.key ?? current.instanceId) &&
    original.id === current.id &&
    original.repoId === current.repoId &&
    original.path === current.path &&
    original.hostId === current.hostId &&
    original.runtimeOwnerEnvironmentId === current.runtimeOwnerEnvironmentId &&
    original.createdAt === current.createdAt &&
    JSON.stringify(original.creatorProvenance) === JSON.stringify(current.creatorProvenance)
  )
}

export function clearLinkedReview(
  get: () => AppState,
  scope: LinkedReviewClearScope | undefined,
  args: { linkedPRNumber: number; branch: string; requestHeadOid: string | null },
  kind: 'diverged' | 'branch-mismatch',
  suppressHostedReviewRefresh = false
): void {
  if (!scope) {
    return
  }
  const predicate =
    kind === 'diverged'
      ? shouldApplyDivergedLinkedPRClear
      : shouldApplyBranchMismatchedLinkedPRClear
  void get().updateWorktreeMeta(scope.workspace.id, CLEARED_HOSTED_REVIEW_SELECTION_UPDATES, {
    executionHostId: scope.workspace.hostId ?? getRepoExecutionHostId(scope.repository),
    ...(suppressHostedReviewRefresh ? { suppressHostedReviewRefresh: true } : {}),
    shouldApply: (current) => {
      const now = captureLinkedReviewClearScope(get(), scope.workspace.id, scope.repository)
      return Boolean(
        current &&
        now &&
        now.linkMutationGeneration === scope.linkMutationGeneration &&
        sameWorkspace(scope.workspace, now.workspace) &&
        sameWorkspace(scope.workspace, current) &&
        (kind !== 'branch-mismatch' ||
          JSON.stringify(current.pushTarget) === JSON.stringify(scope.workspace.pushTarget)) &&
        predicate({ worktree: current, ...args })
      )
    }
  })
}
