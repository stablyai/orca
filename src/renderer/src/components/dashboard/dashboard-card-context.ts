import { branchName } from '@/lib/git-utils'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { AppState } from '@/store/types'
import type {
  DashboardCardLinearIssue,
  DashboardCardReview
} from '../../../../shared/dashboard-snapshot'
import { buildLinearIssueUrl } from '../../../../shared/linear/links'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { isPositiveHostedReviewNumber } from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import {
  DEFAULT_WORKSPACE_STATUSES,
  getWorkspaceStatus
} from '../../../../shared/workspace-statuses'
import {
  canUseParentPrChecksGitHubPRCacheEntry,
  getParentPrChecksGitHubPRCacheEntry
} from '../right-sidebar/parent-pr-checks-github-pr-cache'
import { canUseParentPrChecksHostedReviewCacheEntry } from '../right-sidebar/parent-pr-checks-hosted-review-cache'

export type DashboardCardContextState = Partial<
  Pick<AppState, 'hostedReviewCache' | 'prCache' | 'settings' | 'workspaceStatuses'>
>

export type DashboardCardContext = {
  workspaceStatus: WorkspaceStatusDefinition
  hasReview: boolean
  review?: DashboardCardReview
  linearIssue?: DashboardCardLinearIssue
}

/** Keeps the two cache paths below emitting the same shape. */
function toCardReview(review: HostedReviewInfo): DashboardCardReview {
  return {
    number: review.number,
    state: review.state,
    ...(review.status ? { checksStatus: review.status } : {}),
    ...(review.url ? { url: review.url } : {})
  }
}

function resolveLinearIssue(worktree: Worktree): DashboardCardLinearIssue | undefined {
  const identifier = worktree.linkedLinearIssue?.trim()
  if (!identifier) {
    return undefined
  }
  const url = buildLinearIssueUrl({
    identifier,
    organizationUrlKey: worktree.linkedLinearIssueOrganizationUrlKey
  })
  return { identifier, ...(url ? { url } : {}) }
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
  worktree: Worktree
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
    canUseParentPrChecksHostedReviewCacheEntry(worktree, hostedReview, hostedReviewEntry)
  ) {
    return toCardReview(hostedReview)
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
  return review ? toCardReview(review) : undefined
}

export function resolveDashboardCardContext(
  state: DashboardCardContextState,
  repo: Repo | null,
  worktree: Worktree
): DashboardCardContext {
  const statuses =
    state.workspaceStatuses && state.workspaceStatuses.length > 0
      ? state.workspaceStatuses
      : DEFAULT_WORKSPACE_STATUSES
  const workspaceStatusId = getWorkspaceStatus(worktree, statuses)
  return {
    workspaceStatus:
      statuses.find((status) => status.id === workspaceStatusId) ?? DEFAULT_WORKSPACE_STATUSES[0],
    review: resolveReview(state, repo, worktree),
    linearIssue: resolveLinearIssue(worktree),
    hasReview: hasLinkedReview(worktree)
  }
}
