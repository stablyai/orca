import { capturePRCheckContract } from '@/lib/source-control/checks/pr-check-observation-contract'
import type { StateCreator } from 'zustand'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AppState } from '../../types'
import type { RuntimeFocusSettings } from '../../../../../shared/github/cache/github-cache-key'
import type { GitHubSlice } from '../github-slice-contract'
import type { Repo } from '../../../../../shared/repo-types'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { CacheEntry, GitHubPRFallbackSource } from '../cache/cache-model'
import type { PRRefreshStateClearToken } from '../refresh/pr-refresh-state'

import type {
  GitHubPRRefreshCandidate,
  PRSnapshotReply
} from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  normalizeGitHubPRForBranchOutcome,
  githubPRTransportFailureOutcome
} from '../../../../../shared/github/pull-requests/refresh/pull-request-for-branch-outcome'
import { isPRRevalidationOnly } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { inflightPRRequests, prRequestGenerations } from '../requests/request-coordination'
import { getRuntimeRepoTarget } from '../repositories/repository-routing'
import { isWslHostOffForForge, withForgeHostOffSkip } from '../repositories/wsl-host-off-forge'
import { cachedPRCandidateFields } from './pr-refresh-cached-candidate-fields'
import { lookupPRForBranchOverIpc } from './pr-for-branch-ipc-fallback'
import { findWorktreeById } from '../refresh/worktree-refresh'
import { captureLinkedReviewClearScope } from './linked-review-clear'
import { applyPullRequestLookupOutcome } from './pull-request-lookup-settlement'
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
  const request = (async () => {
    try {
      const runtimeRepo = getRuntimeRepoTarget(get(), { repoId, repoPath }, requestTarget)
      if (runtimeRepo && isWslHostOffForForge(get(), runtimeRepo.target.environmentId)) {
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) => withForgeHostOffSkip(s.prRefreshStates, cacheKey))
        }
        return cached?.data ?? null
      }
      const checkContract = capturePRCheckContract(get, runtimeRepo?.target ?? { kind: 'local' })
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
        ? callRuntimeRpc<PRSnapshotReply | PRInfo | null>(
            runtimeRepo.target,
            'github.prForBranch',
            {
              repo: runtimeRepo.repo.id,
              branch,
              linkedPRNumber,
              currentHeadOid: requestHeadOid,
              ...(options?.reason ? { reason: options.reason } : {}),
              ...(options?.reason === 'swr'
                ? {
                    acceptRevalidationOnly: true,
                    ...(options.userRefresh !== true && options.selected === true
                      ? { selected: true }
                      : {})
                  }
                : {}),
              ...(options?.userRefresh === true ? { userRefresh: true } : {}),
              ...(fallbackPRNumber !== null
                ? { fallbackPRNumber, acceptMergedFallbackPR: fallbackPRSource !== null }
                : {})
            },
            { timeoutMs: 30_000, signal: options?.signal, ...checkContract.sourceRpcOptions }
          ).then((result) =>
            isPRRevalidationOnly(result) ? result : normalizeGitHubPRForBranchOutcome(result)
          )
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
            return isPRRevalidationOnly(response)
              ? response
              : normalizeGitHubPRForBranchOutcome(response)
          })()
      const outcome = await response.catch(() => {
        transportFailed = true
        return githubPRTransportFailureOutcome()
      })
      if (!checkContract.sourceCurrent() || options?.signal?.aborted) {
        return cached?.data ?? null
      }
      if (prRequestGenerations.get(cacheKey) === generation) {
        const inflight = inflightPRRequests.get(cacheKey)
        if (inflight?.generation === generation) {
          inflight.outcome = outcome
        }
      }
      if (isPRRevalidationOnly(outcome)) {
        return get().prCache[cacheKey]?.data ?? null
      }
      return applyPullRequestLookupOutcome({
        set, get, outcome, transportFailed, cacheKey, cached, generation, options,
        isRuntime: runtimeRepo !== null, repo, repoId, repoPath, branch, requestSettings,
        executionHostId, checkContract, clearScope, requestHeadOid, linkedPRNumber,
        fallbackPRNumber, fallbackPRSource, requestStartedAt, requestStartedHostedReviewEntry
      })
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
