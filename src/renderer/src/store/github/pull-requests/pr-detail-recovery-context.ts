import type { AppState } from '../../types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { Repo } from '../../../../../shared/repo-types'
import type { PRRefreshErrorType } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/cache/github-cache-key'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { isStaleMergedGitHubReviewForHead } from '../../slices/hosted-review/hosted-review-cache-state'
import { selectUsableGitHubPR } from '../../../components/right-sidebar/checks-panel/checks-panel-review'
import { findWorktreeById } from '../refresh/worktree-refresh'
import { findRepoForGitHubOwner } from '../repositories/repository-routing'
import { settingsForGitHubRepoOwner } from '../work-items/work-item-routing'

/** What the visible Checks panel asks the store to reconcile; the store rechecks it against live state. */
export type PRDetailRecoveryContext = {
  worktreeId: string
  repoId: string
  repoPath: string
  /** The panel owner's execution host, so same id/path rows on other hosts are never chosen. */
  executionHostId: string
  branch: string
  headOid: string | null
  linkedPRNumber: number | null
  /** Positive evidence number used only when no durable link exists. */
  hintPRNumber: number | null
  hostedReviewCacheKey: string
  selectionRevision: string
}

export type PRDetailRecoveryStatus =
  | { kind: 'unsupported' }
  | { kind: 'waiting' }
  | { kind: 'paused'; notBefore: number }
  | { kind: 'admitted' }
  | { kind: 'failed'; errorType?: PRRefreshErrorType }
  | { kind: 'timeout' }
  | { kind: 'unusable' }
  | { kind: 'resolved' }
  /** Superseded or cancelled for a manual action: ordinary refresh state owns the status line. */
  | { kind: 'closed' }

export type PRDetailRecoveryUiState = {
  contextKey: string
  status: PRDetailRecoveryStatus
  /** Bumped once per terminal outcome so assistive tech hears it even when the text repeats. */
  terminalCount: number
}

export function prDetailRecoverySelectionRevision(
  worktree: Pick<
    Worktree,
    | 'linkedPR'
    | 'suppressedGitHubPR'
    | 'linkedGitLabMR'
    | 'linkedBitbucketPR'
    | 'linkedAzureDevOpsPR'
    | 'linkedGiteaPR'
  >
): string {
  return [
    worktree.linkedPR,
    worktree.suppressedGitHubPR,
    worktree.linkedGitLabMR,
    worktree.linkedBitbucketPR,
    worktree.linkedAzureDevOpsPR,
    worktree.linkedGiteaPR
  ]
    .map((value) => value ?? '')
    .join('|')
}

export function prDetailRecoveryContextKey(context: PRDetailRecoveryContext): string {
  return JSON.stringify([
    context.worktreeId,
    context.repoId,
    context.repoPath,
    context.executionHostId,
    context.branch,
    context.headOid,
    context.linkedPRNumber,
    context.linkedPRNumber == null ? context.hintPRNumber : null,
    context.hostedReviewCacheKey,
    context.selectionRevision
  ])
}

export type PRDetailRecoveryOwner = {
  repo: Repo
  executionHostId: string
  cacheKey: string
  requestSettings: ReturnType<typeof settingsForGitHubRepoOwner>
}

export function resolvePRDetailRecoveryOwner(
  state: AppState,
  context: PRDetailRecoveryContext
): PRDetailRecoveryOwner | null {
  const repo = findRepoForGitHubOwner(
    state,
    context.repoId,
    context.repoPath,
    context.executionHostId
  )
  if (!repo) {
    return null
  }
  const requestSettings = settingsForGitHubRepoOwner(state.settings, repo)
  return {
    repo,
    executionHostId: getRepoExecutionHostId(repo),
    requestSettings,
    cacheKey: getGitHubRepoCacheKey(
      context.repoPath,
      repo.id,
      context.branch,
      requestSettings,
      repo.connectionId,
      repo.executionHostId,
      true
    )
  }
}

/** Live recheck: same worktree HEAD, link/suppression/provider revision, and still no usable PR. */
export function prDetailRecoveryContextLive(
  state: AppState,
  context: PRDetailRecoveryContext,
  owner: PRDetailRecoveryOwner
): boolean {
  const worktree = findWorktreeById(state, context.worktreeId, owner.executionHostId)
  return (
    worktree !== null &&
    (worktree.head ?? null) === context.headOid &&
    prDetailRecoverySelectionRevision(worktree) === context.selectionRevision &&
    !hasUsableGitHubPR(state, context, owner, worktree)
  )
}

export function hasUsableGitHubPR(
  state: AppState,
  context: PRDetailRecoveryContext,
  owner: PRDetailRecoveryOwner,
  worktree = findWorktreeById(state, context.worktreeId, owner.executionHostId)
): boolean {
  if (!worktree) {
    return false
  }
  const entry = state.prCache[owner.cacheKey]
  const pr = isStaleMergedGitHubReviewForHead(entry, worktree.head) ? null : (entry?.data ?? null)
  return (
    selectUsableGitHubPR({
      hostedReview: state.hostedReviewCache[context.hostedReviewCacheKey]?.data ?? null,
      pr,
      linkedPR: worktree.linkedPR ?? null,
      suppressedGitHubPR: worktree.suppressedGitHubPR ?? null,
      linkedGitLabMR: worktree.linkedGitLabMR ?? null,
      linkedBitbucketPR: worktree.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: worktree.linkedGiteaPR ?? null
    }) !== null
  )
}
