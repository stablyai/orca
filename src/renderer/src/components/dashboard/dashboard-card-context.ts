import { branchName } from '@/lib/git-utils'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { AppState } from '@/store/types'
import type {
  DashboardCardOdooTicket,
  DashboardCardReview
} from '../../../../shared/dashboard-snapshot'
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
  odooTicket?: DashboardCardOdooTicket
}

/**
 * `linkedWorkItem` caches the ticket's title/URL, but a link made without it
 * (or displaced by another provider) still leaves `linkedOdooTicket` set — so
 * the id alone is enough to badge the card.
 */
export function resolveDashboardCardOdooTicket(
  worktree: Worktree
): DashboardCardOdooTicket | undefined {
  const cached = worktree.linkedWorkItem?.provider === 'odoo' ? worktree.linkedWorkItem : undefined
  const id = worktree.linkedOdooTicket ?? cached?.number ?? null
  if (id === null || !Number.isFinite(id) || id <= 0) {
    return undefined
  }
  const instanceId = worktree.linkedOdooInstanceId ?? cached?.odooInstanceId ?? undefined
  // Only trust the cached title/URL when it actually describes this ticket.
  const describesLinked = cached?.number === id
  return {
    id,
    ...(describesLinked && cached?.title ? { title: cached.title } : {}),
    ...(describesLinked && cached?.url ? { url: cached.url } : {}),
    ...(instanceId ? { instanceId } : {})
  }
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
  worktree: Worktree
): DashboardCardContext {
  const statuses =
    state.workspaceStatuses && state.workspaceStatuses.length > 0
      ? state.workspaceStatuses
      : DEFAULT_WORKSPACE_STATUSES
  const workspaceStatusId = getWorkspaceStatus(worktree, statuses)
  const review = resolveReview(state, repo, worktree)
  return {
    workspaceStatus:
      statuses.find((status) => status.id === workspaceStatusId) ?? DEFAULT_WORKSPACE_STATUSES[0],
    review,
    hasReview: hasLinkedReview(worktree) || review !== undefined,
    odooTicket: resolveDashboardCardOdooTicket(worktree)
  }
}

/** The snapshot fields a card context contributes; shared by the workspace and
 *  agent rows so the two stay in step. */
export function dashboardCardContextFields(context: DashboardCardContext | undefined): {
  workspaceStatusId: string | undefined
  workspaceStatusLabel: string | undefined
  workspaceStatusColor: string | undefined
  hasReview: boolean | undefined
  review: DashboardCardContext['review'] | undefined
  odooTicket: DashboardCardContext['odooTicket'] | undefined
} {
  return {
    workspaceStatusId: context?.workspaceStatus.id,
    workspaceStatusLabel: context?.workspaceStatus.label,
    workspaceStatusColor: context?.workspaceStatus.color,
    hasReview: context?.hasReview,
    review: context?.review,
    odooTicket: context?.odooTicket
  }
}
