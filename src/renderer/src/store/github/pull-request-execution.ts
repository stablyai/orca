import type { StateCreator } from 'zustand'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AppState } from '../types'
import type { RuntimeFocusSettings } from '../../../../shared/github/github-cache-key'
import type { GitHubSlice } from './slice-types'
import type { Repo } from '../../../../shared/repo-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { CacheEntry, GitHubPRFallbackSource } from './cache-model'
import { withDirectPRRefreshSettlement, type PRRefreshStateClearToken } from './pr-refresh-state'

import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-request-refresh-types'
import {
  normalizeGitHubPRForBranchOutcome,
  githubPRTransportFailureOutcome
} from '../../../../shared/github/pull-request-for-branch-outcome'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { inflightPRRequests, prRequestGenerations } from './request-coordination'
import { getRuntimeRepoTarget } from './repository-routing'
import { applyCachedChecksStatus } from './pr-check-status-cache'
import { isWslHostOffForForge, withForgeHostOffSkip } from './wsl-host-off-forge'
import { cachedPRCandidateFields } from './pr-refresh-cached-candidate-fields'
import { lookupPRForBranchOverIpc } from './pr-for-branch-ipc-fallback'
import { setGitHubPRResultCaches, shouldPreserveExistingPRForFallbackMiss } from './pr-result-cache'
import { findWorktreeById, isStaleExactLinkedPRLookup } from './worktree-refresh'
import {
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../../../shared/github/linked-pr-staleness'
import { captureLinkedReviewClearScope, clearLinkedReview } from './linked-review-clear'
export function startPullRequestLookup(args: {
  set: Parameters<StateCreator<AppState>>[0]
  get: Parameters<StateCreator<AppState>>[1]
  repoPath: string
  branch: string
  options: Parameters<GitHubSlice['fetchPRForBranch']>[2]
  repo: Repo | undefined
  repoId: string | undefined
  requestSettings: RuntimeFocusSettings
  requestTarget: RuntimeClientTarget
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
    requestTarget,
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
  const executionHostId = repo ? getRepoExecutionHostId(repo) : undefined
  const ownerHostId = executionHostId ?? LOCAL_EXECUTION_HOST_ID
  const request = (async () => {
    try {
      const runtimeRepo = getRuntimeRepoTarget(get(), { repoId, repoPath }, requestTarget)
      if (runtimeRepo && isWslHostOffForForge(get(), runtimeRepo.target.environmentId)) {
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) => withForgeHostOffSkip(s.prRefreshStates, cacheKey))
        }
        return cached?.data ?? null
      }
      const candidateWorktree = options?.worktreeId
        ? findWorktreeById(get(), options.worktreeId, executionHostId)
        : null
      const clearScope =
        linkedPRNumber != null
          ? captureLinkedReviewClearScope(get(), options?.worktreeId, repo)
          : undefined
      const requestHeadOid = candidateWorktree?.head ?? null
      let transportFailed = false
      const response = runtimeRepo
        ? callRuntimeRpc<PRRefreshOutcome | PRInfo | null>(
            runtimeRepo.target,
            'github.prForBranch',
            {
              repo: runtimeRepo.repo.id,
              branch,
              linkedPRNumber,
              currentHeadOid: requestHeadOid,
              ...(options?.reason ? { reason: options.reason } : {}),
              ...(options?.userRefresh === true ? { userRefresh: true } : {}),
              ...(fallbackPRNumber !== null
                ? { fallbackPRNumber, acceptMergedFallbackPR: fallbackPRSource !== null }
                : {})
            },
            { timeoutMs: 30_000 }
          ).then((result) => normalizeGitHubPRForBranchOutcome(result))
        : (async () => {
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
              isSelected: options?.worktreeId === get().activeWorktreeId,
              ...cachedPRCandidateFields(cached)
            }
            const reason = options?.reason ?? 'manual'
            const requestOptions = options?.userRefresh === true ? { userRefresh: true } : {}
            const response = window.api.gh.refreshPRNow
              ? await window.api.gh.refreshPRNow({ candidate, reason, ...requestOptions })
              : await lookupPRForBranchOverIpc(candidate, reason, {
                  ...requestOptions,
                  repoOwnerExecutionHostId: options?.repoOwnerExecutionHostId
                })
            return normalizeGitHubPRForBranchOutcome(response)
          })()
      const outcome = await response.catch(() => {
        transportFailed = true
        return githubPRTransportFailureOutcome()
      })
      const pr = outcome.kind === 'found' ? outcome.pr : null
      // RPC and lost IPC replies get no coordinator settlement; a lost reply is reported only to the click that asked, so polls stay silent.
      if (
        prRequestGenerations.get(cacheKey) === generation &&
        (outcome.kind !== 'upstream-error' ||
          (transportFailed ? options?.userRefresh === true : runtimeRepo))
      ) {
        set((s) => withDirectPRRefreshSettlement(s, cacheKey, outcome, requestStartedAt))
      }
      if (outcome.kind === 'upstream-error') {
        return cached?.data ?? null
      }
      if (prRequestGenerations.get(cacheKey) === generation) {
        let skippedStaleLinkedPRLookup = false
        set((s) => {
          // Why: unlinking a PR mid exact-linked-PR-lookup must stop the older result from restoring the manual link UI.
          if (isStaleExactLinkedPRLookup(s, options?.worktreeId, linkedPRNumber, executionHostId)) {
            skippedStaleLinkedPRLookup = true
            return s
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
            pr:
              pr && !runtimeRepo
                ? applyCachedChecksStatus(
                    s,
                    { cacheKey, repoPath, branch, repoId, connectionId: repo?.connectionId },
                    pr,
                    outcome.fetchedAt,
                    ownerHostId
                  )
                : pr,
            fetchedAt: outcome.fetchedAt,
            rejectedPRUrls: outcome.kind === 'no-pr' ? outcome.rejectedPRUrls : undefined,
            fetchedHeadOid: requestHeadOid,
            worktreeId: options?.worktreeId,
            linkedPRNumber,
            fallbackPRNumber,
            fallbackPRSource,
            requestStartedAt,
            requestStartedEntry: requestStartedHostedReviewEntry
          })
          return updates.prCache || updates.hostedReviewCache ? updates : s
        })
        if (skippedStaleLinkedPRLookup) {
          return null
        }
        const linkedPRWorktree = clearScope
          ? findWorktreeById(get(), clearScope.workspace.id, executionHostId)
          : null
        if (
          options?.worktreeId &&
          linkedPRWorktree &&
          linkedPRNumber != null &&
          shouldClearDivergedLinkedMergedPR({ pr, linkedPRNumber, requestHeadOid })
        ) {
          clearLinkedReview(get, clearScope, { linkedPRNumber, branch, requestHeadOid }, 'diverged')
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
          clearLinkedReview(
            get,
            clearScope,
            { linkedPRNumber, branch, requestHeadOid },
            'branch-mismatch',
            true
          )
          // Re-resolve by branch now so Checks recover this refresh instead of serving the stale linked PR.
          void get()
            .fetchPRForBranch(repoPath, branch, {
              force: true,
              repoId,
              repoOwnerExecutionHostId: executionHostId,
              worktreeId: options.worktreeId,
              reason: options.reason,
              ...(options.userRefresh === true ? { userRefresh: true } : {})
            })
            .catch((err) => console.warn('Branch-scoped PR refetch skipped:', err))
        }
      }
      if (
        shouldPreserveExistingPRForFallbackMiss({
          currentPR: get().prCache[cacheKey]?.data,
          nextPR: pr,
          state: get(),
          worktreeId: options?.worktreeId,
          executionHostId,
          linkedPRNumber,
          rejectedPRUrls: outcome.kind === 'no-pr' ? outcome.rejectedPRUrls : undefined
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
