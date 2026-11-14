import { branchName } from '@/lib/source-control/branches/branch-name'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import type { AppState } from '@/store/types'
import type { DashboardCardReview } from '../../../../../shared/dashboard-snapshot'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-github'
import { isPositiveHostedReviewNumber } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Repo } from '../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../shared/worktree/types'
import { getWorkspaceStatus } from '../../../../../shared/workspace-statuses'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../../shared/workspace-status-defaults'
import {
  canUseParentPrChecksGitHubPRCacheEntry,
  getParentPrChecksGitHubPRCacheEntry
} from '../../right-sidebar/hosted-review/folder-checks/parent-pr-checks-github-pr-cache'
import { canUseParentPrChecksHostedReviewCacheEntry } from '../../right-sidebar/hosted-review/folder-checks/parent-pr-checks-hosted-review-cache'
import type { Translate } from '@/i18n/use-translate'

export type DashboardCardContextState = Partial<
  Pick<AppState, 'hostedReviewCache' | 'prCache' | 'settings' | 'workspaceStatuses'>
>

export type DashboardCardContext = {
  workspaceStatus: WorkspaceStatusDefinition
  hasReview: boolean
  review?: DashboardCardReview
}

function hasLinkedReview(worktree: Worktree): boolean {
  return [
    worktree.linkedPR,
    worktree.linkedGitLabMR,
    worktree.linkedBitbucketPR,
    worktree.linkedAzureDevOpsPR,
    worktree.linkedGiteaPR
  ].some(isPositiveHostedReviewNumber)
}

function resolveReview(
  state: DashboardCardContextState,
  repo: Repo | null,
  worktree: Worktree,
  t?: Translate
): DashboardCardReview | undefined {
  if (!repo || !state.hostedReviewCache || !state.prCache || repo.kind === 'folder') {
    return undefined
  }
  const branch = branchName(worktree.branch)
  const hostedReviewEntry =
    state.hostedReviewCache[
      getHostedReviewCacheKey(
        repo.path,
        branch,
        state.settings,
        repo.id,
        repo.connectionId,
        repo.executionHostId,
        true
      )
    ]
  const hostedReview = hostedReviewEntry?.data
  if (
    hostedReview &&
    canUseParentPrChecksHostedReviewCacheEntry(worktree, hostedReview, hostedReviewEntry, t)
  ) {
    return { number: hostedReview.number, state: hostedReview.state }
  }
  const prEntry = getParentPrChecksGitHubPRCacheEntry({
    prCache: state.prCache,
    repo,
    branch,
    settings: state.settings ?? null
  })
  const review = canUseParentPrChecksGitHubPRCacheEntry(worktree, prEntry, hostedReviewEntry)
    ? hostedReviewInfoFromGitHubPRInfo(prEntry.data)
    : undefined
  return review ? { number: review.number, state: review.state } : undefined
}

export function resolveDashboardCardContext(
  state: DashboardCardContextState,
  repo: Repo | null,
  worktree: Worktree,
  t?: Translate
): DashboardCardContext {
  const statuses =
    state.workspaceStatuses && state.workspaceStatuses.length > 0
      ? state.workspaceStatuses
      : DEFAULT_WORKSPACE_STATUSES
  const workspaceStatusId = getWorkspaceStatus(worktree, statuses)
  const review = resolveReview(state, repo, worktree, t)
  return {
    workspaceStatus:
      statuses.find((status) => status.id === workspaceStatusId) ?? DEFAULT_WORKSPACE_STATUSES[0],
    review,
    hasReview: hasLinkedReview(worktree) || review !== undefined
  }
}
