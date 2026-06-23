import type { PRCheckDetail, Repo, Worktree } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getWorktreeCardPrDisplay } from '@/components/sidebar/worktree-card-pr-display'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey, linkedReviewHintKey } from '@/store/slices/hosted-review'
import { prChecksCacheSuffix } from '@/store/slices/github'
import {
  PARENT_PR_CHECKS_GROUP_LABELS,
  PARENT_PR_CHECKS_GROUP_ORDER,
  type BuildParentPrChecksRowsArgs,
  type ParentPrChecksCacheEntry,
  type ParentPrChecksProjection,
  type ParentPrChecksRefreshOutcome,
  type ParentPrChecksRow,
  type ParentPrChecksSummary
} from './parent-pr-checks-row-types'
import {
  classifyParentPrChecksRowStatus,
  getRowCheckTone,
  getRowSummary,
  groupForRowStatus
} from './parent-pr-checks-row-status'

export type {
  ParentPrChecksGroupKey,
  ParentPrChecksProjection,
  ParentPrChecksRefreshOutcome,
  ParentPrChecksRow,
  ParentPrChecksRowStatus,
  ParentPrChecksSummary
} from './parent-pr-checks-row-types'

export function buildParentPrChecksProjection(
  args: BuildParentPrChecksRowsArgs
): ParentPrChecksProjection {
  const repoById = new Map(args.repos.map((repo) => [repo.id, repo]))
  const rows = args.worktrees.map((worktree) =>
    buildParentPrChecksRow({
      ...args,
      worktree,
      repo: repoById.get(worktree.repoId) ?? null
    })
  )
  const groups = PARENT_PR_CHECKS_GROUP_ORDER.map((key) => ({
    key,
    label: PARENT_PR_CHECKS_GROUP_LABELS[key],
    rows: rows.filter((row) => row.group === key)
  })).filter((group) => group.rows.length > 0)
  return { rows, groups, summary: summarizeParentPrChecksRows(rows) }
}

export function summarizeParentPrChecksRows(
  rows: readonly ParentPrChecksRow[]
): ParentPrChecksSummary {
  return {
    attached: rows.length,
    knownReview: rows.filter((row) => row.reviewLabel !== null && row.status !== 'noReview').length,
    failing: rows.filter((row) => row.group === 'needsAttention').length,
    pending: rows.filter((row) => row.group === 'pending').length,
    passing: rows.filter((row) => row.group === 'passing').length,
    noPr: rows.filter((row) => row.status === 'noReview').length,
    unknown: rows.filter((row) =>
      [
        'notFetched',
        'loading',
        'linkedDetailsUnavailable',
        'refreshError',
        'unsupported',
        'unavailable'
      ].includes(row.status)
    ).length
  }
}

export function getParentPrChecksRefreshIdentity(
  worktree: Worktree,
  repo: Repo | null,
  branch: string | null
): string {
  return [
    worktree.id,
    worktree.instanceId ?? '',
    repo?.id ?? worktree.repoId,
    branch ?? '',
    linkedReviewHintKey(getLinkedReviewHints(worktree))
  ].join('::')
}

function buildParentPrChecksRow(
  args: BuildParentPrChecksRowsArgs & { worktree: Worktree; repo: Repo | null }
): ParentPrChecksRow {
  const branch = getBranchName(args.worktree)
  const refreshIdentity = getParentPrChecksRefreshIdentity(args.worktree, args.repo, branch)
  const outcome = args.refreshOutcomes?.get(refreshIdentity)
  const reviewSnapshot = getReviewSnapshot(args, branch, outcome)
  const fallbackDisplay = getWorktreeCardPrDisplay(
    reviewSnapshot.review,
    args.worktree.linkedPR,
    args.worktree.linkedGitLabMR ?? null,
    args.worktree.linkedBitbucketPR ?? null,
    args.worktree.linkedAzureDevOpsPR ?? null,
    args.worktree.linkedGiteaPR ?? null
  )
  const review = reviewSnapshot.review
  const status = classifyParentPrChecksRowStatus({
    isUnavailable: !args.repo || isFolderRepo(args.repo) || args.worktree.isBare || !branch,
    review,
    hasCacheEntry: reviewSnapshot.hasCacheEntry,
    outcome,
    hasFallbackReview: fallbackDisplay !== null
  })
  const checkDetails = getCheckDetails(args, review, branch)
  const detailNames = getCheckDetailNames(checkDetails)

  return {
    id: args.worktree.id,
    refreshIdentity,
    worktree: args.worktree,
    repo: args.repo,
    branch,
    status,
    group: groupForRowStatus(status),
    checkTone: getRowCheckTone(status, review),
    title: getRowTitle(args.worktree, branch, review, fallbackDisplay?.title),
    reviewLabel: getReviewLabel(review, fallbackDisplay),
    reviewUrl: review?.url ?? fallbackDisplay?.url ?? null,
    reviewState: review?.state ?? fallbackDisplay?.state ?? null,
    provider: review?.provider ?? fallbackDisplay?.provider ?? null,
    summary: getRowSummary(status, review, detailNames),
    detailNames,
    checks: checkDetails,
    isRefreshing: outcome?.kind === 'loading',
    hasLinkedReview: hasLinkedReview(args.worktree)
  }
}

function getReviewSnapshot(
  args: BuildParentPrChecksRowsArgs & { worktree: Worktree; repo: Repo | null },
  branch: string | null,
  outcome: ParentPrChecksRefreshOutcome | undefined
): { review: HostedReviewInfo | null | undefined; hasCacheEntry: boolean } {
  if (outcome?.kind === 'found') {
    return { review: outcome.review, hasCacheEntry: true }
  }
  if (!args.repo || !branch) {
    return { review: undefined, hasCacheEntry: false }
  }
  const scopedArgs = { ...args, repo: args.repo }
  const hostedReviewEntry = args.hostedReviewCache[getHostedReviewKey(scopedArgs, branch)]
  if (hostedReviewEntry?.data) {
    return { review: hostedReviewEntry.data, hasCacheEntry: true }
  }
  const prEntry = args.prCache[getPRKey(scopedArgs, branch)]
  if (prEntry?.data) {
    return {
      review: hostedReviewInfoFromGitHubPRInfo(prEntry.data),
      hasCacheEntry: true
    }
  }
  return {
    review: hostedReviewEntry?.data,
    hasCacheEntry: hostedReviewEntry !== undefined
  }
}

function getRowTitle(
  worktree: Worktree,
  branch: string | null,
  review: HostedReviewInfo | null | undefined,
  fallbackTitle: string | undefined
): string {
  return review?.title ?? fallbackTitle ?? branch ?? worktree.displayName
}

function getReviewLabel(
  review: HostedReviewInfo | null | undefined,
  fallback: ReturnType<typeof getWorktreeCardPrDisplay>
): string | null {
  const provider = review?.provider ?? fallback?.provider
  const number = review?.number ?? fallback?.number
  if (provider === undefined || number === undefined) {
    return null
  }
  return provider === 'gitlab' ? `!${number}` : `#${number}`
}

function getCheckDetails(
  args: BuildParentPrChecksRowsArgs & { repo: Repo | null },
  review: HostedReviewInfo | null | undefined,
  branch: string | null
): PRCheckDetail[] {
  if (!args.repo || !branch || review?.provider !== 'github') {
    return []
  }
  return getGitHubChecksEntry({ ...args, repo: args.repo }, review)?.data ?? []
}

function getCheckDetailNames(checks: readonly PRCheckDetail[]): string[] {
  const interesting = checks.filter(
    (check) =>
      check.conclusion === 'failure' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'cancelled' ||
      check.conclusion === 'pending' ||
      check.conclusion === null ||
      check.status === 'queued' ||
      check.status === 'in_progress'
  )
  return interesting.slice(0, 2).map((check) => check.name)
}

function getGitHubChecksEntry(
  args: BuildParentPrChecksRowsArgs & { repo: Repo },
  review: HostedReviewInfo
): ParentPrChecksCacheEntry<PRCheckDetail[]> | undefined {
  const prRepo = null
  const withHead = getGitHubRepoCacheKey(
    args.repo.path,
    args.repo.id,
    prChecksCacheSuffix(review.number, prRepo, review.headSha),
    args.settings,
    args.repo.connectionId,
    args.repo.executionHostId
  )
  const withoutHead = getGitHubRepoCacheKey(
    args.repo.path,
    args.repo.id,
    prChecksCacheSuffix(review.number, prRepo),
    args.settings,
    args.repo.connectionId,
    args.repo.executionHostId
  )
  return args.checksCache[withHead] ?? args.checksCache[withoutHead]
}

function getHostedReviewKey(
  args: BuildParentPrChecksRowsArgs & { repo: Repo },
  branch: string
): string {
  return getHostedReviewCacheKey(
    args.repo.path,
    branch,
    args.settings,
    args.repo.id,
    args.repo.connectionId,
    args.repo.executionHostId
  )
}

function getPRKey(args: BuildParentPrChecksRowsArgs & { repo: Repo }, branch: string): string {
  return getGitHubPRCacheKey(
    args.repo.path,
    args.repo.id,
    branch,
    args.settings,
    args.repo.connectionId,
    args.repo.executionHostId
  )
}

function getBranchName(worktree: Worktree): string | null {
  const identity = getWorktreeGitIdentityDisplay(worktree)
  return identity?.kind === 'branch' ? identity.branchName : null
}

function hasLinkedReview(worktree: Worktree): boolean {
  return Boolean(
    worktree.linkedPR ??
    worktree.linkedGitLabMR ??
    worktree.linkedBitbucketPR ??
    worktree.linkedAzureDevOpsPR ??
    worktree.linkedGiteaPR ??
    null
  )
}

function getLinkedReviewHints(worktree: Worktree): Parameters<typeof linkedReviewHintKey>[0] {
  return {
    linkedGitHubPR: worktree.linkedPR ?? null,
    linkedGitLabMR: worktree.linkedGitLabMR ?? null,
    linkedBitbucketPR: worktree.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: worktree.linkedGiteaPR ?? null
  }
}
