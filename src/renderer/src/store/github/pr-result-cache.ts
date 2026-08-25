import type { AppState } from '../types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import type { GitHubPRFallbackSource } from './cache-model'
import { withBoundedCacheEntry } from './cache-policy'
import { prRefreshStartedHostedReviewEntries } from './request-coordination'
import {
  shouldWritePRCacheForHostedReviewSync,
  syncHostedReviewCacheFromGitHubPRResult
} from './pr-result-routing'
import { findWorktreeById } from './worktree-refresh'

const PR_REFRESH_STARTED_HOSTED_REVIEW_ENTRY_MAX = 128

export function applyPRCacheResult(
  cache: AppState['prCache'],
  cacheKey: string,
  pr: PRInfo | null,
  fetchedAt: number,
  accepted: boolean,
  preserveExisting: boolean
): AppState['prCache'] {
  if (preserveExisting) {
    return cache
  }
  if (accepted) {
    return withBoundedCacheEntry(cache, cacheKey, { data: pr, fetchedAt })
  }
  if (!cache[cacheKey]) {
    return cache
  }
  const next = { ...cache }
  delete next[cacheKey]
  return next
}

export function prRefreshStartedEntryKey(sequence: number, cacheKey: string): string {
  return `${sequence}::${cacheKey}`
}

export function deletePRRefreshStartedEntry(sequence: number | undefined, cacheKey: string): void {
  if (sequence !== undefined && sequence > 0) {
    prRefreshStartedHostedReviewEntries.delete(prRefreshStartedEntryKey(sequence, cacheKey))
  }
}

export function setPRRefreshStartedHostedReviewEntry(
  key: string,
  entry: AppState['hostedReviewCache'][string] | undefined
): void {
  if (entry === undefined) {
    prRefreshStartedHostedReviewEntries.delete(key)
    return
  }
  prRefreshStartedHostedReviewEntries.delete(key)
  prRefreshStartedHostedReviewEntries.set(key, entry)
  while (prRefreshStartedHostedReviewEntries.size > PR_REFRESH_STARTED_HOSTED_REVIEW_ENTRY_MAX) {
    const oldest = prRefreshStartedHostedReviewEntries.keys().next()
    if (oldest.done) {
      return
    }
    prRefreshStartedHostedReviewEntries.delete(oldest.value)
  }
}

export function setGitHubPRResultCaches(
  state: AppState,
  args: {
    prCacheKey: string
    repoPath: string
    branch: string
    settings: AppState['settings']
    repoId?: string
    connectionId?: string | null
    executionHostId?: string | null
    hasRepoOwner?: boolean
    pr: PRInfo | null
    fetchedAt: number
    worktreeId?: string
    linkedPRNumber?: number | null
    fallbackPRNumber?: number | null
    fallbackPRSource?: GitHubPRFallbackSource | null
    requestStartedAt?: number
    requestStartedEntry?: AppState['hostedReviewCache'][string]
  }
): Partial<AppState> {
  const preserveExistingPRForFallbackMiss = shouldPreserveExistingPRForFallbackMiss({
    currentPR: state.prCache[args.prCacheKey]?.data,
    nextPR: args.pr,
    state,
    worktreeId: args.worktreeId,
    linkedPRNumber: args.linkedPRNumber,
    fallbackPRNumber: args.fallbackPRNumber,
    fallbackPRSource: args.fallbackPRSource
  })
  const hostedReviewSync = syncHostedReviewCacheFromGitHubPRResult({
    cache: state.hostedReviewCache,
    repoPath: args.repoPath,
    branch: args.branch,
    settings: args.settings,
    repoId: args.repoId,
    connectionId: args.connectionId,
    executionHostId: args.executionHostId,
    hasRepoOwner: args.hasRepoOwner,
    pr: args.pr,
    fetchedAt: args.fetchedAt,
    linkedPRNumber: args.linkedPRNumber,
    fallbackPRNumber: args.fallbackPRNumber,
    fallbackPRSource: args.fallbackPRSource,
    preserveExistingPRForFallbackMiss,
    requestStartedAt: args.requestStartedAt,
    requestStartedEntry: args.requestStartedEntry
  })
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId,
    args.executionHostId,
    args.hasRepoOwner === true
  )
  const nextPRCache = applyPRCacheResult(
    state.prCache,
    args.prCacheKey,
    args.pr,
    args.fetchedAt,
    shouldWritePRCacheForHostedReviewSync({
      hostedReviewSyncAccepted: hostedReviewSync.accepted,
      hostedReviewEntry: state.hostedReviewCache[hostedReviewCacheKey],
      pr: args.pr,
      linkedPRNumber: args.linkedPRNumber,
      fallbackPRNumber: args.fallbackPRNumber
    }),
    preserveExistingPRForFallbackMiss
  )
  return {
    ...(nextPRCache === state.prCache ? {} : { prCache: nextPRCache }),
    ...(hostedReviewSync.cache === state.hostedReviewCache
      ? {}
      : { hostedReviewCache: hostedReviewSync.cache })
  }
}

export function applyGitHubPRResultToCaches(args: {
  prCache: AppState['prCache']
  hostedReviewCache: AppState['hostedReviewCache']
  prCacheKey: string
  repoPath: string
  branch: string
  settings: AppState['settings']
  repoId?: string
  connectionId?: string | null
  executionHostId?: string | null
  hasRepoOwner?: boolean
  pr: PRInfo | null
  fetchedAt: number
  state: AppState
  worktreeId?: string
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
  requestStartedAt?: number
  requestStartedEntry?: AppState['hostedReviewCache'][string]
}): {
  prCache: AppState['prCache']
  hostedReviewCache: AppState['hostedReviewCache']
} {
  const preserveExistingPRForFallbackMiss = shouldPreserveExistingPRForFallbackMiss({
    currentPR: args.prCache[args.prCacheKey]?.data,
    nextPR: args.pr,
    state: args.state,
    worktreeId: args.worktreeId,
    linkedPRNumber: args.linkedPRNumber,
    fallbackPRNumber: args.fallbackPRNumber,
    fallbackPRSource: args.fallbackPRSource
  })
  const hostedReviewSync = syncHostedReviewCacheFromGitHubPRResult({
    cache: args.hostedReviewCache,
    repoPath: args.repoPath,
    branch: args.branch,
    settings: args.settings,
    repoId: args.repoId,
    connectionId: args.connectionId,
    executionHostId: args.executionHostId,
    hasRepoOwner: args.hasRepoOwner,
    pr: args.pr,
    fetchedAt: args.fetchedAt,
    linkedPRNumber: args.linkedPRNumber,
    fallbackPRNumber: args.fallbackPRNumber,
    fallbackPRSource: args.fallbackPRSource,
    preserveExistingPRForFallbackMiss,
    requestStartedAt: args.requestStartedAt,
    requestStartedEntry: args.requestStartedEntry
  })
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId,
    args.executionHostId,
    args.hasRepoOwner === true
  )
  return {
    prCache: applyPRCacheResult(
      args.prCache,
      args.prCacheKey,
      args.pr,
      args.fetchedAt,
      shouldWritePRCacheForHostedReviewSync({
        hostedReviewSyncAccepted: hostedReviewSync.accepted,
        hostedReviewEntry: args.hostedReviewCache[hostedReviewCacheKey],
        pr: args.pr,
        linkedPRNumber: args.linkedPRNumber,
        fallbackPRNumber: args.fallbackPRNumber
      }),
      preserveExistingPRForFallbackMiss
    ),
    hostedReviewCache: hostedReviewSync.cache
  }
}
export function shouldPreserveExistingPRForFallbackMiss(args: {
  currentPR: PRInfo | null | undefined
  nextPR: PRInfo | null
  state: AppState
  worktreeId?: string
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
}): boolean {
  if (
    args.nextPR !== null ||
    args.linkedPRNumber != null ||
    args.currentPR?.state !== 'merged' ||
    typeof args.currentPR.headSha !== 'string' ||
    args.currentPR.headSha.length === 0
  ) {
    return false
  }
  // Why: gate the global worktree scan so batched refresh aliases don't multiply full scans (common paths don't need it).
  const worktree = args.worktreeId ? findWorktreeById(args.state, args.worktreeId) : null
  const worktreeHead = worktree?.head
  // Why: keep a merged PR only when its cached head matches the worktree head — exactly or a confirmed-contained commit.
  const preservesMergedPRForCurrentHead =
    typeof worktreeHead === 'string' &&
    worktreeHead.length > 0 &&
    (args.currentPR.headSha === worktreeHead ||
      args.currentPR.confirmedContainedHeadOid === worktreeHead)

  return preservesMergedPRForCurrentHead
}
