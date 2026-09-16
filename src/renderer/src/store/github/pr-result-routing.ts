import type { AppState } from '../types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import {
  getHostedReviewCacheKey,
  linkedReviewHintKey
} from '../slices/hosted-review-cache-identity'
import {
  hasNewerHostedReviewCacheEntry,
  withHostedReviewCacheEntry
} from '../slices/hosted-review-cache-state'
import type { GitHubPRFallbackSource } from './cache-model'

export function githubHostedReviewFallbackPRNumber(
  state: AppState,
  repoPath: string,
  repoId: string | undefined,
  branch: string,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): number | null {
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    repoPath,
    branch,
    state.settings,
    repoId,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
  const hostedReview = state.hostedReviewCache[hostedReviewCacheKey]?.data
  return hostedReview?.provider === 'github' ? hostedReview.number : null
}

export function shouldClearHostedReviewForNoGitHubPR(
  entry: AppState['hostedReviewCache'][string] | undefined
): boolean {
  // Why: a GitHub-only miss must not suppress GitLab/other hosted-review discovery via provider-neutral branch misses.
  if (!entry) {
    return false
  }
  if (entry.data?.provider === 'github') {
    return true
  }
  return entry.data === null && isGitHubLinkedReviewHintKey(entry.linkedReviewHintKey)
}

export function isGitHubLinkedReviewHintKey(hintKey: string | undefined): boolean {
  return hintKey?.split('|').some((key) => key.startsWith('github:')) ?? false
}

export function prLookupHintKey(
  linkedPRNumber: number | null,
  fallbackPRNumber: number | null
): string {
  if (linkedPRNumber !== null) {
    return `linked:${linkedPRNumber}`
  }
  return fallbackPRNumber !== null ? `fallback:${fallbackPRNumber}` : ''
}

export function linkedReviewHintKeyForNoGitHubPR(
  entry: AppState['hostedReviewCache'][string] | undefined
): string | undefined {
  if (entry?.data?.provider === 'github') {
    return isGitHubLinkedReviewHintKey(entry.linkedReviewHintKey)
      ? entry.linkedReviewHintKey
      : linkedReviewHintKey({ linkedGitHubPR: entry.data.number })
  }
  return entry?.linkedReviewHintKey
}

export function syncHostedReviewCacheFromGitHubPRResult(args: {
  cache: AppState['hostedReviewCache']
  repoPath: string
  branch: string
  settings: AppState['settings']
  repoId?: string
  connectionId?: string | null
  executionHostId?: string | null
  hasRepoOwner?: boolean
  pr: PRInfo | null
  fetchedAt: number
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
  preserveExistingPRForFallbackMiss?: boolean
  requestStartedAt?: number
  requestStartedEntry?: AppState['hostedReviewCache'][string]
}): { cache: AppState['hostedReviewCache']; accepted: boolean } {
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId,
    args.executionHostId,
    args.hasRepoOwner === true
  )
  if (
    args.requestStartedAt !== undefined &&
    hasNewerHostedReviewCacheEntry(
      args.cache,
      hostedReviewCacheKey,
      args.requestStartedAt,
      args.requestStartedEntry
    )
  ) {
    return { cache: args.cache, accepted: false }
  }
  const hostedReviewEntry = args.cache[hostedReviewCacheKey]
  if (
    args.requestStartedAt === undefined &&
    hostedReviewEntry !== undefined &&
    hostedReviewEntry.fetchedAt >= args.fetchedAt
  ) {
    return { cache: args.cache, accepted: false }
  }
  if (args.pr && hostedReviewEntry?.data && hostedReviewEntry.data.provider !== 'github') {
    return { cache: args.cache, accepted: false }
  }
  // Why: a hosted-review row survives an authoritative miss only when the paired PR cache preserves a terminal, head-current PR.
  if (
    !args.pr &&
    args.linkedPRNumber == null &&
    args.fallbackPRNumber != null &&
    args.fallbackPRSource !== 'hosted-review' &&
    hostedReviewEntry?.data?.provider === 'github' &&
    hostedReviewEntry.data.number === args.fallbackPRNumber &&
    args.preserveExistingPRForFallbackMiss === true &&
    canPreserveReviewForFallbackMiss(hostedReviewEntry.data.state)
  ) {
    return { cache: args.cache, accepted: false }
  }
  if (!args.pr && !shouldClearHostedReviewForNoGitHubPR(hostedReviewEntry)) {
    return { cache: args.cache, accepted: hostedReviewEntry?.data == null }
  }
  // Why: hosted-review fallbacks may be stale exact links; inherit branch provenance only when already proven.
  const branchLookupGitHubPRNumber =
    args.pr &&
    args.linkedPRNumber == null &&
    (args.fallbackPRSource !== 'hosted-review' ||
      args.pr.number !== args.fallbackPRNumber ||
      hostedReviewEntry?.branchLookupGitHubPRNumber === args.pr.number)
      ? args.pr.number
      : undefined
  // Why: the key embeds the branch, so this write path grows with every distinct
  // (host, repo, branch) a session refreshes. Share the hosted-review slice's bound.
  return {
    cache: withHostedReviewCacheEntry(args.cache, hostedReviewCacheKey, {
      data: args.pr ? hostedReviewInfoFromGitHubPRInfo(args.pr) : null,
      fetchedAt: args.fetchedAt,
      linkedReviewHintKey: args.pr
        ? linkedReviewHintKey({ linkedGitHubPR: args.pr.number })
        : linkedReviewHintKeyForNoGitHubPR(hostedReviewEntry),
      ...(branchLookupGitHubPRNumber !== undefined ? { branchLookupGitHubPRNumber } : {})
    }),
    accepted: true
  }
}

export function shouldWritePRCacheForHostedReviewSync(args: {
  hostedReviewSyncAccepted: boolean
  hostedReviewEntry: AppState['hostedReviewCache'][string] | undefined
  pr: PRInfo | null
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
}): boolean {
  // Why: grouping reads prCache while cards read hostedReviewCache; keep them from drifting when a result is rejected for the card.
  if (args.hostedReviewSyncAccepted) {
    return true
  }
  const exactPRNumber = args.linkedPRNumber ?? args.fallbackPRNumber ?? null
  return (
    exactPRNumber !== null &&
    args.pr?.number === exactPRNumber &&
    args.hostedReviewEntry?.data?.provider === 'github' &&
    args.hostedReviewEntry.data.number === exactPRNumber
  )
}

function canPreserveReviewForFallbackMiss(state: PRInfo['state'] | undefined): boolean {
  return state === 'closed' || state === 'merged'
}
