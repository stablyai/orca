import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { Repo } from '../../../../shared/repo-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { CacheEntry, GitHubPRFallbackSource } from './cache-model'
import type { PRRefreshStateClearToken } from './pr-refresh-state'

import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-request-refresh-types'
import { normalizeGitHubPRForBranchOutcome } from '../../../../shared/github/pull-request-for-branch-outcome'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { debouncedSaveCache } from './cache-persistence'
import { inflightPRRequests, prRequestGenerations } from './request-coordination'
import { getRuntimeRepoTarget } from './repository-routing'
import { setGitHubPRResultCaches, shouldPreserveExistingPRForFallbackMiss } from './pr-result-cache'
import {
  findUniqueWorktreeById,
  findWorktreeById,
  isStaleExactLinkedPRLookup,
  shouldApplyBranchMismatchedLinkedPRClear,
  shouldApplyDivergedLinkedPRClear,
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from './worktree-refresh'
export function startPullRequestLookup(args: {
  set: Parameters<StateCreator<AppState>>[0]
  get: Parameters<StateCreator<AppState>>[1]
  repoPath: string
  branch: string
  options: Parameters<GitHubSlice['fetchPRForBranch']>[2]
  repo: Repo | undefined
  repoId: string | undefined
  requestSettings: AppState['settings']
  cacheKey: string
  cached: CacheEntry<PRInfo> | undefined
  linkedPRNumber: number | null
  fallbackPRNumber: number | null
  fallbackPRSource: GitHubPRFallbackSource | null
  generation: number
  requestStartedAt: number
  requestStartedHostedReviewEntry: AppState['hostedReviewCache'][string] | undefined
  requestStartedPRRefreshToken: PRRefreshStateClearToken | null
}): Promise<PRInfo | null> {
  const {
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
  } = args
  const request = (async () => {
    try {
      const runtimeRepo = getRuntimeRepoTarget(get(), repoPath, requestSettings)
      const candidateWorktree = options?.worktreeId
        ? findWorktreeById(get(), options.worktreeId)
        : null
      const requestHeadOid = candidateWorktree?.head ?? null
      const outcome = runtimeRepo
        ? await callRuntimeRpc<PRRefreshOutcome | PRInfo | null>(
            runtimeRepo.target,
            'github.prForBranch',
            {
              repo: runtimeRepo.repo.id,
              branch,
              linkedPRNumber,
              currentHeadOid: requestHeadOid,
              ...(fallbackPRNumber !== null
                ? { fallbackPRNumber, acceptMergedFallbackPR: fallbackPRSource !== null }
                : {})
            },
            { timeoutMs: 30_000 }
          ).then((result) => normalizeGitHubPRForBranchOutcome(result))
        : await (async () => {
            const candidate: GitHubPRRefreshCandidate = {
              repoId: repoId ?? '',
              repoPath,
              repoKind: repo?.kind ?? 'git',
              branch,
              cacheKey,
              worktreeId: options?.worktreeId,
              currentHeadOid: requestHeadOid,
              linkedPRNumber,
              fallbackPRNumber,
              fallbackPRSource,
              connectionId: repo?.connectionId ?? null,
              executionHostId: repo?.executionHostId ?? null,
              cachedFetchedAt: cached?.fetchedAt ?? null,
              cachedHasPR: cached?.data ? true : cached ? false : null,
              cachedPRState: cached?.data?.state ?? null,
              cachedChecksStatus: cached?.data?.checksStatus ?? null,
              cachedMergeable: cached?.data?.mergeable ?? null,
              cachedMergeStateStatus: cached?.data?.mergeStateStatus ?? null
            }
            const response = window.api.gh.refreshPRNow
              ? await window.api.gh.refreshPRNow({ candidate })
              : await window.api.gh.prForBranch({
                  repoPath,
                  repoId,
                  branch,
                  linkedPRNumber,
                  fallbackPRNumber,
                  acceptMergedFallbackPR: fallbackPRNumber !== null && fallbackPRSource !== null,
                  currentHeadOid: requestHeadOid
                })
            return normalizeGitHubPRForBranchOutcome(response)
          })()
      const pr: PRInfo | null =
        outcome.kind === 'found' ? outcome.pr : outcome.kind === 'no-pr' ? null : null
      if (outcome.kind === 'upstream-error') {
        // Why: the runtime RPC path skips the coordinator broadcast that fills prRefreshStates on native, so record the classified error here for Checks parity with native (design criterion 2).
        if (runtimeRepo && prRequestGenerations.get(cacheKey) === generation) {
          set((s) => {
            const nextStates = { ...s.prRefreshStates }
            delete nextStates[cacheKey]
            nextStates[cacheKey] = {
              status: 'error',
              reason: 'swr',
              updatedAt: Date.now(),
              message: outcome.message,
              errorType: outcome.errorType,
              nextAutoRetryAt: outcome.nextAutoRetryAt,
              retryDisabledUntil: outcome.retryDisabledUntil
            }
            return { prRefreshStates: nextStates }
          })
        }
        return cached?.data ?? null
      }
      if (prRequestGenerations.get(cacheKey) === generation) {
        let skippedStaleLinkedPRLookup = false
        let didUpdatePRCache = false
        set((s) => {
          // Why: unlinking a PR mid exact-linked-PR-lookup must stop the older result from restoring the manual link UI.
          if (isStaleExactLinkedPRLookup(s, options?.worktreeId, linkedPRNumber)) {
            skippedStaleLinkedPRLookup = true
            return {}
          }
          const updates = setGitHubPRResultCaches(s, {
            prCacheKey: cacheKey,
            repoPath,
            branch,
            settings: requestSettings,
            repoId,
            connectionId: repo?.connectionId,
            executionHostId: repo?.executionHostId,
            hasRepoOwner: repo !== undefined,
            pr,
            fetchedAt: outcome.fetchedAt,
            worktreeId: options?.worktreeId,
            linkedPRNumber,
            fallbackPRNumber,
            fallbackPRSource,
            requestStartedAt,
            requestStartedEntry: requestStartedHostedReviewEntry
          })
          didUpdatePRCache = updates.prCache !== undefined
          return updates
        })
        if (skippedStaleLinkedPRLookup) {
          return null
        }
        if (didUpdatePRCache) {
          debouncedSaveCache(get())
        }
        const linkedPRWorktree =
          options?.worktreeId && linkedPRNumber != null
            ? findUniqueWorktreeById(
                get(),
                options.worktreeId,
                repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
              )
            : null
        if (
          options?.worktreeId &&
          linkedPRWorktree &&
          linkedPRNumber != null &&
          shouldClearDivergedLinkedMergedPR({ pr, linkedPRNumber, requestHeadOid })
        ) {
          // Why: only clear the durable link that produced this exact probe; drift means the stale result no longer owns the worktree.
          void get().updateWorktreeMeta(
            options.worktreeId,
            { linkedPR: null },
            {
              shouldApply: () =>
                shouldApplyDivergedLinkedPRClear({
                  worktree:
                    findUniqueWorktreeById(
                      get(),
                      options.worktreeId!,
                      repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
                    ) ?? undefined,
                  linkedPRNumber,
                  branch,
                  requestHeadOid
                })
            }
          )
        }
        if (
          options?.worktreeId &&
          linkedPRWorktree &&
          linkedPRNumber != null &&
          shouldClearBranchMismatchedLinkedOpenPR({
            pr,
            linkedPRNumber,
            branch,
            requestHeadOid,
            pushTargetBranch: linkedPRWorktree.pushTarget?.branchName ?? null
          })
        ) {
          void get().updateWorktreeMeta(
            options.worktreeId,
            { linkedPR: null },
            {
              // Why: the branch-scoped PR refetch below updates both caches; the generic metadata refresh would duplicate provider work.
              suppressHostedReviewRefresh: true,
              shouldApply: () =>
                shouldApplyBranchMismatchedLinkedPRClear({
                  worktree:
                    findUniqueWorktreeById(
                      get(),
                      options.worktreeId!,
                      repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
                    ) ?? undefined,
                  linkedPRNumber,
                  branch,
                  requestHeadOid
                })
            }
          )
          // Re-resolve by branch now so Checks recover this refresh instead of serving the stale linked PR.
          void get().fetchPRForBranch(repoPath, branch, {
            force: true,
            repoId,
            worktreeId: options.worktreeId
          })
        }
      }
      if (
        shouldPreserveExistingPRForFallbackMiss({
          currentPR: get().prCache[cacheKey]?.data,
          nextPR: pr,
          state: get(),
          worktreeId: options?.worktreeId,
          linkedPRNumber,
          fallbackPRNumber,
          fallbackPRSource
        })
      ) {
        return get().prCache[cacheKey]?.data ?? null
      }
      return pr ?? null
    } catch (err) {
      console.error('Failed to fetch PR:', err)
      return null
    } finally {
      const activeRequest = inflightPRRequests.get(cacheKey)
      if (activeRequest?.generation === generation) {
        inflightPRRequests.delete(cacheKey)
        if (prRequestGenerations.get(cacheKey) === generation) {
          prRequestGenerations.delete(cacheKey)
        }
      }
      if (requestStartedPRRefreshToken) {
        get().expireGitHubPRRefreshState(cacheKey, requestStartedPRRefreshToken)
      }
    }
  })()
  return request
}
