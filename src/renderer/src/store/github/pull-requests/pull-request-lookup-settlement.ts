import type { StateCreator } from 'zustand'
import type { PRCheckContract } from '@/lib/source-control/checks/pr-check-observation-contract'
import type { AppState } from '../../types'
import type { RuntimeFocusSettings } from '../../../../../shared/github/cache/github-cache-key'
import type { GitHubSlice } from '../github-slice-contract'
import type { Repo } from '../../../../../shared/repo-types'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { CacheEntry, GitHubPRFallbackSource } from '../cache/cache-model'
import type { PRRefreshOutcome } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { withDirectPRRefreshSettlement } from '../refresh/pr-refresh-state'
import { prRequestGenerations } from '../requests/request-coordination'
import { setGitHubPRResultCaches, shouldPreserveExistingPRForFallbackMiss } from './pr-result-cache'
import { findWorktreeById, isStaleExactLinkedPRLookup } from '../refresh/worktree-refresh'
import {
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../../../../shared/github/pull-requests/refresh/linked-pr-staleness'
import { clearLinkedReview, type LinkedReviewClearScope } from './linked-review-clear'

export type PullRequestLookupSettlement = {
  set: Parameters<StateCreator<AppState>>[0]
  get: Parameters<StateCreator<AppState>>[1]
  outcome: PRRefreshOutcome
  transportFailed: boolean
  cacheKey: string
  cached: CacheEntry<PRInfo> | undefined
  /** The renderer generation that must still own the alias for this result to publish. */
  generation: number
  options: Parameters<GitHubSlice['fetchPRForBranch']>[2]
  isRuntime: boolean
  repo: Repo | undefined
  repoId: string | undefined
  repoPath: string
  branch: string
  requestSettings: RuntimeFocusSettings
  executionHostId: string | undefined
  checkContract: PRCheckContract
  clearScope: LinkedReviewClearScope | undefined
  requestHeadOid: string | null
  linkedPRNumber: number | null
  fallbackPRNumber: number | null
  fallbackPRSource: GitHubPRFallbackSource | null
  requestStartedAt: number
  requestStartedHostedReviewEntry: AppState['hostedReviewCache'][string] | undefined
}

/** The guarded PR writer: source, generation, unlink and hosted-entry rules decide what a result may change. */
export function applyPullRequestLookupOutcome(args: PullRequestLookupSettlement): PRInfo | null {
  const {
    set,
    get,
    outcome,
    transportFailed,
    cacheKey,
    cached,
    generation,
    options,
    isRuntime,
    repo,
    repoId,
    repoPath,
    branch,
    requestSettings,
    executionHostId,
    checkContract,
    clearScope,
    requestHeadOid,
    linkedPRNumber,
    fallbackPRNumber,
    fallbackPRSource,
    requestStartedAt,
    requestStartedHostedReviewEntry
  } = args
  if (!checkContract.sourceCurrent()) {
    return cached?.data ?? null
  }
  const pr = outcome.kind === 'found' ? outcome.pr : null
  let acceptedPR: PRInfo | null = null
  // RPC and lost IPC replies get no coordinator settlement; a lost reply is reported only to the click that asked, so polls stay silent.
  if (
    prRequestGenerations.get(cacheKey) === generation &&
    (outcome.kind !== 'upstream-error' ||
      (transportFailed ? options?.userRefresh === true : isRuntime))
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
        pr,
        checkContract,
        overlayChecks: !isRuntime,
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
      acceptedPR = (updates.prCache ?? s.prCache)[cacheKey]?.data ?? null
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
  return acceptedPR ?? null
}
