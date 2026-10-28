import type { AppState } from '../types'
import type { RuntimeFocusSettings } from '../../../../shared/github/github-cache-key'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
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

type GitHubPRResultCacheArgs = {
  prCacheKey: string
  repoPath: string
  branch: string
  settings: RuntimeFocusSettings
  repoId?: string
  connectionId?: string | null
  executionHostId?: string | null
  hasRepoOwner?: boolean
  pr: PRInfo | null
  fetchedAt: number
  rejectedPRUrls?: readonly string[]
  worktreeId?: string
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: GitHubPRFallbackSource | null
  requestStartedAt?: number
  fetchedHeadOid?: string | null
  requestStartedEntry?: AppState['hostedReviewCache'][string]
}

export function applyPRCacheResult(
  cache: AppState['prCache'],
  cacheKey: string,
  pr: PRInfo | null,
  fetchedAt: number,
  accepted: boolean,
  preserveExisting: boolean,
  fetchedHeadOid?: string | null
): AppState['prCache'] {
  if (preserveExisting) {
    return cache
  }
  if (accepted) {
    return withBoundedCacheEntry(cache, cacheKey, {
      data: pr,
      fetchedAt,
      ...(fetchedHeadOid ? { fetchedHeadOid } : {})
    })
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
  args: GitHubPRResultCacheArgs
): Partial<AppState> {
  const next = applyGitHubPRResultToCaches({
    ...args,
    state,
    prCache: state.prCache,
    hostedReviewCache: state.hostedReviewCache
  })
  return {
    ...(next.prCache === state.prCache ? {} : { prCache: next.prCache }),
    ...(next.hostedReviewCache === state.hostedReviewCache
      ? {}
      : { hostedReviewCache: next.hostedReviewCache })
  }
}

export function applyGitHubPRResultToCaches(
  args: GitHubPRResultCacheArgs & {
    prCache: AppState['prCache']
    hostedReviewCache: AppState['hostedReviewCache']
    state: AppState
  }
): {
  prCache: AppState['prCache']
  hostedReviewCache: AppState['hostedReviewCache']
} {
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId,
    args.executionHostId,
    args.hasRepoOwner === true
  )
  const hostedReviewEntry = args.hostedReviewCache[hostedReviewCacheKey]
  const current = args.prCache[args.prCacheKey]
  const prNumber = args.pr?.number ?? null
  // The coordinator delivers each outcome twice; skip duplicates only while both caches name the same PR.
  if (
    current?.fetchedAt === args.fetchedAt &&
    (current.data?.number ?? null) === prNumber &&
    current.data?.url === args.pr?.url &&
    hostedReviewEntry?.data?.url === args.pr?.url &&
    (hostedReviewEntry?.data?.provider === 'github' ? hostedReviewEntry.data.number : null) ===
      prNumber
  ) {
    return { prCache: args.prCache, hostedReviewCache: args.hostedReviewCache }
  }
  const preserveExistingPRForFallbackMiss = shouldPreserveExistingPRForFallbackMiss({
    currentPR: current?.data,
    nextPR: args.pr,
    state: args.state,
    worktreeId: args.worktreeId,
    executionHostId: args.hasRepoOwner ? getRepoExecutionHostId(args) : undefined,
    linkedPRNumber: args.linkedPRNumber,
    rejectedPRUrls: args.rejectedPRUrls
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
  return {
    prCache: applyPRCacheResult(
      args.prCache,
      args.prCacheKey,
      args.pr,
      args.fetchedAt,
      shouldWritePRCacheForHostedReviewSync({
        hostedReviewSyncAccepted: hostedReviewSync.accepted,
        hostedReviewEntry,
        pr: args.pr,
        linkedPRNumber: args.linkedPRNumber,
        fallbackPRNumber: args.fallbackPRNumber
      }),
      preserveExistingPRForFallbackMiss,
      args.fetchedHeadOid
    ),
    hostedReviewCache: hostedReviewSync.cache
  }
}
export function shouldPreserveExistingPRForFallbackMiss(args: {
  currentPR: PRInfo | null | undefined
  nextPR: PRInfo | null
  state: AppState
  worktreeId?: string
  executionHostId?: string
  linkedPRNumber?: number | null
  rejectedPRUrls?: readonly string[]
}): boolean {
  if (
    args.nextPR !== null ||
    args.linkedPRNumber != null ||
    args.currentPR?.state !== 'merged' ||
    args.rejectedPRUrls?.includes(args.currentPR.url) ||
    typeof args.currentPR.headSha !== 'string' ||
    args.currentPR.headSha.length === 0
  ) {
    return false
  }
  // Why: gate the global worktree scan so batched refresh aliases don't multiply full scans (common paths don't need it).
  const worktree = args.worktreeId
    ? findWorktreeById(args.state, args.worktreeId, args.executionHostId)
    : null
  const worktreeHead = worktree?.head
  // Why: keep a merged PR only when its cached head matches the worktree head — exactly or a confirmed-contained commit.
  const preservesMergedPRForCurrentHead =
    typeof worktreeHead === 'string' &&
    worktreeHead.length > 0 &&
    (args.currentPR.headSha === worktreeHead ||
      args.currentPR.confirmedContainedHeadOid === worktreeHead)

  return preservesMergedPRForCurrentHead
}
