import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { GitHubPRFallbackSource } from './cache-model'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { prCacheKey } from './cache-identity'
import { isFresh } from './cache-policy'
import { buildGitHubPRRefreshStateClearToken } from './pr-refresh-state'
import { githubHostedReviewFallbackPRNumber, prLookupHintKey } from './pr-result-routing'
import { inflightPRRequests, prRequestGenerations } from './request-coordination'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import {
  findWorktreeById,
  shouldApplyDivergedLinkedPRClear,
  shouldClearDivergedLinkedMergedPR
} from './worktree-refresh'
import { startPullRequestLookup } from './pull-request-execution'

export const createPullRequestActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'fetchPRForBranch'> => ({
  fetchPRForBranch: async (repoPath, branch, options): Promise<PRInfo | null> => {
    const repoLookup = getGitHubRepoLookupIndex(get().repos)
    const repo = options?.repoId
      ? repoLookup.findById(options.repoId)
      : repoLookup.findByPath(repoPath)
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = settingsForGitHubRepoOwner(get().settings, repo)
    const cacheKey = prCacheKey(
      repoPath,
      repoId,
      branch,
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      repo !== undefined
    )
    const cached = get().prCache[cacheKey]
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
    const lookupHintKey = prLookupHintKey(linkedPRNumber, fallbackPRNumber)
    const linkedRefetch =
      cached?.data === null && (linkedPRNumber !== null || fallbackPRNumber !== null)
    if (!options?.force && !linkedRefetch && isFresh(cached)) {
      // Why: even a fresh cache hit carries the head-scoped divergence signal; if a prior clear was declined for a mid-request head move and we're back on that head, clear the durable link.
      if (
        options?.worktreeId &&
        linkedPRNumber != null &&
        cached?.data?.headDivergedFromMergedPRAtOid != null
      ) {
        const currentHeadOid = findWorktreeById(get(), options.worktreeId)?.head ?? null
        if (
          shouldClearDivergedLinkedMergedPR({
            pr: cached.data,
            linkedPRNumber,
            requestHeadOid: currentHeadOid
          })
        ) {
          void get().updateWorktreeMeta(
            options.worktreeId,
            { linkedPR: null },
            {
              shouldApply: (worktree) =>
                shouldApplyDivergedLinkedPRClear({
                  worktree,
                  linkedPRNumber,
                  branch,
                  requestHeadOid: currentHeadOid
                })
            }
          )
        }
      }
      return cached.data
    }

    const inflightRequest = inflightPRRequests.get(cacheKey)
    if (
      inflightRequest &&
      (!options?.force || inflightRequest.force) &&
      inflightRequest.lookupHintKey === lookupHintKey &&
      !linkedRefetch
    ) {
      return inflightRequest.promise
    }

    const generation = (prRequestGenerations.get(cacheKey) ?? 0) + 1
    const requestStartedAt = Date.now()
    const requestStartedHostedReviewEntry = get().hostedReviewCache[hostedReviewCacheKey]
    const requestStartedPRRefreshState = get().prRefreshStates[cacheKey]
    const requestStartedPRRefreshToken = buildGitHubPRRefreshStateClearToken(
      requestStartedPRRefreshState,
      get().prRefreshSequences,
      cacheKey
    )
    prRequestGenerations.set(cacheKey, generation)

    const request = startPullRequestLookup({
      set,
      get,
      repoPath,
      branch,
      options,
      repo,
      repoId,
      requestSettings,
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

    inflightPRRequests.set(cacheKey, {
      promise: request,
      force: Boolean(options?.force),
      generation,
      lookupHintKey
    })
    return request
  }
})
