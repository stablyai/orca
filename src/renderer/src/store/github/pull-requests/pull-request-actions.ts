import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { GitHubSlice } from '../github-slice-contract'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubPRFallbackSource } from '../cache/cache-model'
import { getHostedReviewCacheKey } from '../../slices/hosted-review/hosted-review-cache-identity'
import { findRepoForGitHubOwner } from '../repositories/repository-routing'
import '../cache/cache-identity'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/cache/github-cache-key'
import { isFresh } from '../cache/cache-policy'
import {
  buildGitHubPRRefreshStateClearToken,
  bypassesGitHubPRRefreshFreshness
} from '../refresh/pr-refresh-state'
import { githubHostedReviewFallbackPRNumber, prLookupHintKey } from './pr-result-routing'
import { nextLookupGeneration } from '../../slices/hosted-review/refresh/lookup-generation-sequence'
import {
  inflightPRRequests,
  prRequestGenerations,
  type InflightPR
} from '../requests/request-coordination'
import { sharedPromiseSettlementWaiters } from '../../../../../shared/promise-settlement-waiters'
import { getGitHubSourceTarget, settingsForGitHubRepoOwner } from '../work-items/work-item-routing'
import { captureLinkedReviewClearScope, clearLinkedReview } from './linked-review-clear'
import { shouldClearDivergedLinkedMergedPR } from '../../../../../shared/github/pull-requests/refresh/linked-pr-staleness'
import { startPullRequestLookup } from './pull-request-execution'
import { findWorktreeById } from '../refresh/worktree-refresh'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'

export const createPullRequestActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'fetchPRForBranch'> => ({
  fetchPRForBranch: async (repoPath, branch, options): Promise<PRInfo | null> => {
    const repo = findRepoForGitHubOwner(
      get(),
      options?.repoId,
      repoPath,
      options?.repoOwnerExecutionHostId
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = settingsForGitHubRepoOwner(get().settings, repo)
    const cacheKey = getGitHubRepoCacheKey(
      repoPath,
      repoId,
      branch,
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      repo !== undefined
    )
    const cached = get().prCache[cacheKey]
    if (options?.signal?.aborted) {
      return cached?.data ?? null
    }
    const hostedReviewCacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      requestSettings,
      repoId,
      repo?.connectionId,
      repo?.executionHostId,
      repo !== undefined
    )
    // Why: a prior linkedPR-less caller may have cached null for this branch; refetch so the cached miss can now resolve via the linkedPR path.
    const linkedPRNumber = options?.linkedPRNumber ?? null
    const explicitFallbackPRNumber = options?.fallbackPRNumber ?? null
    const hostedReviewFallbackPRNumber = githubHostedReviewFallbackPRNumber(
      get(),
      repoPath,
      repoId,
      branch,
      repo?.connectionId,
      repo?.executionHostId,
      repo !== undefined
    )
    const fallbackPRNumber =
      linkedPRNumber == null ? (explicitFallbackPRNumber ?? hostedReviewFallbackPRNumber) : null
    const fallbackPRSource: GitHubPRFallbackSource | null =
      linkedPRNumber != null || fallbackPRNumber == null
        ? null
        : (options?.fallbackPRSource ??
          (explicitFallbackPRNumber != null ? 'explicit' : 'hosted-review'))
    const lookupHintKey = JSON.stringify([
      prLookupHintKey(linkedPRNumber, fallbackPRNumber),
      options?.worktreeId
        ? (findWorktreeById(
            get(),
            options.worktreeId,
            repo ? getRepoExecutionHostId(repo) : undefined
          )?.head ?? null)
        : null
    ])
    const linkedRefetch =
      cached?.data === null && (linkedPRNumber !== null || fallbackPRNumber !== null)
    if (!options?.force && !options?.userRefresh && !linkedRefetch && isFresh(cached)) {
      // Why: even a fresh cache hit carries the head-scoped divergence signal; if a prior clear was declined for a mid-request head move and we're back on that head, clear the durable link.
      if (
        options?.worktreeId &&
        linkedPRNumber != null &&
        cached?.data?.headDivergedFromMergedPRAtOid != null
      ) {
        const scope = captureLinkedReviewClearScope(get(), options.worktreeId, repo)
        const currentHeadOid = scope?.workspace.head ?? null
        if (
          shouldClearDivergedLinkedMergedPR({
            pr: cached.data,
            linkedPRNumber,
            requestHeadOid: currentHeadOid
          })
        ) {
          clearLinkedReview(
            get,
            scope,
            { linkedPRNumber, branch, requestHeadOid: currentHeadOid },
            'diverged'
          )
        }
      }
      return cached.data
    }

    const inflightRequest = inflightPRRequests.get(cacheKey)
    if (
      !options?.userRefresh &&
      inflightRequest &&
      !inflightRequest.controller.signal.aborted &&
      (!options?.force || inflightRequest.force) &&
      inflightRequest.lookupHintKey === lookupHintKey &&
      !(
        inflightRequest.reason === 'swr' &&
        bypassesGitHubPRRefreshFreshness(options?.reason ?? 'manual')
      ) &&
      !linkedRefetch
    ) {
      return waitForPullRequest(
        inflightRequest,
        options,
        () => get().prCache[cacheKey]?.data ?? null
      )
    }

    if (inflightRequest) {
      inflightRequest.superseded = true
    }
    const generation = nextLookupGeneration()
    const requestStartedAt = Date.now()
    const requestStartedHostedReviewEntry = get().hostedReviewCache[hostedReviewCacheKey]
    const requestStartedPRRefreshState = get().prRefreshStates[cacheKey]
    const requestStartedPRRefreshToken = buildGitHubPRRefreshStateClearToken(
      requestStartedPRRefreshState,
      get().prRefreshSequences,
      cacheKey
    )
    prRequestGenerations.set(cacheKey, generation)

    const controller = new AbortController()
    const request = startPullRequestLookup({
      set,
      get,
      repoPath,
      branch,
      options: { ...options, signal: controller.signal, onReadOutcome: undefined },
      repo,
      repoId,
      requestSettings,
      requestTarget: getGitHubSourceTarget(get(), repo),
      cacheKey,
      cached,
      linkedPRNumber,
      fallbackPRNumber,
      fallbackPRSource,
      generation,
      requestStartedAt,
      requestStartedHostedReviewEntry,
      requestStartedPRRefreshToken
    })

    const inflight: InflightPR = {
      promise: request,
      controller,
      waiters: sharedPromiseSettlementWaiters(request),
      force: Boolean(options?.force),
      generation,
      reason: options?.reason,
      lookupHintKey
    }
    inflightPRRequests.set(cacheKey, inflight)
    return waitForPullRequest(inflight, options, () => get().prCache[cacheKey]?.data ?? null)
  }
})

function waitForPullRequest(
  inflight: InflightPR,
  options: Parameters<GitHubSlice['fetchPRForBranch']>[2],
  fallback: () => PRInfo | null
): Promise<PRInfo | null> {
  return inflight.waiters
    .wait({
      signal: options?.signal,
      deferSettled: true,
      onFulfilled: () => {
        if (inflight.outcome && !inflight.superseded) {
          options?.onReadOutcome?.(inflight.outcome)
        }
      },
      onAbandon: () => {
        if (inflight.waiters.waiterCount === 0) {
          inflight.controller.abort()
        }
      }
    })
    .catch((error: unknown) => {
      if (options?.signal?.aborted) {
        return fallback()
      }
      throw error
    })
}
