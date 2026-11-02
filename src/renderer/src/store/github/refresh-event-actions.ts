import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import { applyCachedChecksStatus } from './pr-check-status-cache'
import {
  capPrRefreshSequences,
  capPrRefreshStates,
  pruneExpiredPRRefreshStates
} from './pr-refresh-state'
import {
  applyGitHubPRResultToCaches,
  deletePRRefreshStartedEntry,
  prRefreshStartedEntryKey,
  pruneExpiredPRRefreshStartedEntries,
  setPRRefreshStartedEntry
} from './pr-result-cache'
import {
  prRefreshStartedHostedReviewEntries,
  prRefreshStartedLinkedReviewScopes
} from './request-coordination'
import {
  captureLinkedReviewClearScope,
  clearLinkedReview,
  type LinkedReviewClearScope
} from './linked-review-clear'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { getRefreshAliasExecutionHostId } from './repository-routing'
import { buildWorktreeLookupIndex, isStaleExactLinkedPRLookup } from './worktree-refresh'
import {
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../../../shared/github/linked-pr-staleness'
import type { WorktreeLookupIndex } from './worktree-refresh'

export const createRefreshEventActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'applyGitHubPRRefreshEvent'> => ({
  applyGitHubPRRefreshEvent: (event) => {
    pruneExpiredPRRefreshStartedEntries()
    // Why: local-repo sidebar refresh routes through the main PR coordinator, so run the same guarded diverged-merged-PR clear.
    const divergedLinkedPRClears: {
      worktreeId: string
      linkedPRNumber: number
      branch: string
      requestHeadOid: string | null
      scope: LinkedReviewClearScope
    }[] = []
    const branchMismatchedLinkedPRClears: {
      worktreeId: string
      linkedPRNumber: number
      branch: string
      requestHeadOid: string | null
      scope: LinkedReviewClearScope
    }[] = []
    set((s) => {
      let linkedWorktreeLookupIndex: WorktreeLookupIndex | undefined
      const nextSequences = { ...s.prRefreshSequences }
      const prunedStates = pruneExpiredPRRefreshStates(s.prRefreshStates)
      const nextStates = { ...prunedStates }
      let nextPRCache = s.prCache
      let nextHostedReviewCache = s.hostedReviewCache ?? {}
      let changed = prunedStates !== s.prRefreshStates

      for (const alias of event.aliases) {
        const aliasExecutionHostId = getRefreshAliasExecutionHostId(alias)
        const previousSequence = Math.max(
          nextSequences[alias.cacheKey] ?? 0,
          prRefreshStartedLinkedReviewScopes.get(alias.cacheKey)?.sequence ?? 0
        )
        if (
          event.outcome ? event.sequence < previousSequence : event.sequence <= previousSequence
        ) {
          if (event.outcome || event.status !== 'in-flight') {
            deletePRRefreshStartedEntry(event.sequence, alias.cacheKey)
          }
          continue
        }
        // Why: delete-then-set re-orders this key last so capPrRefreshSequences evicts idle, not active, keys.
        delete nextSequences[alias.cacheKey]
        nextSequences[alias.cacheKey] = event.sequence
        changed = true

        if (event.outcome) {
          const startedEntryKey = prRefreshStartedEntryKey(event.sequence, alias.cacheKey)
          const requestStartedEntry = prRefreshStartedHostedReviewEntries.get(startedEntryKey)
          const requestScope = prRefreshStartedLinkedReviewScopes.get(alias.cacheKey)
          deletePRRefreshStartedEntry(event.sequence, alias.cacheKey)
          if (previousSequence !== event.sequence) {
            deletePRRefreshStartedEntry(previousSequence, alias.cacheKey)
          }
          delete nextStates[alias.cacheKey]
          if (event.outcome.kind === 'upstream-error') {
            nextStates[alias.cacheKey] = {
              status: 'error',
              reason: event.reason,
              updatedAt: Date.now(),
              message: event.outcome.message,
              errorType: event.outcome.errorType,
              nextAutoRetryAt: event.outcome.nextAutoRetryAt,
              retryDisabledUntil: event.outcome.retryDisabledUntil
            }
            continue
          }
          const data =
            event.outcome.kind === 'found'
              ? applyCachedChecksStatus(
                  s,
                  alias,
                  event.outcome.pr,
                  event.outcome.fetchedAt,
                  aliasExecutionHostId
                )
              : null
          const linkedPRNumber = alias.linkedPRNumber ?? null
          // Why: one outcome fans out to many aliases; build one lazy index instead of rescanning worktrees per alias.
          const worktreeLookupIndex =
            alias.worktreeId && linkedPRNumber != null
              ? (linkedWorktreeLookupIndex ??= buildWorktreeLookupIndex(s))
              : undefined
          // Why: a queued refresh finishing after the user unlinks an exact PR must not restore the manual-link UI.
          if (
            isStaleExactLinkedPRLookup(
              s,
              alias.worktreeId,
              linkedPRNumber,
              aliasExecutionHostId,
              worktreeLookupIndex
            )
          ) {
            continue
          }
          if (event.outcome.kind === 'found' && alias.worktreeId) {
            const requestHeadOid = alias.currentHeadOid ?? null
            const scope =
              requestScope?.sequence === event.sequence &&
              requestScope.scope.workspace.id === alias.worktreeId
                ? requestScope.scope
                : undefined
            const worktree = scope?.workspace
            // Why: only the sequence-gate winner owns metadata side effects; late outcomes must not unlink a newer PR.
            if (
              scope &&
              worktree &&
              linkedPRNumber != null &&
              shouldClearDivergedLinkedMergedPR({
                pr: event.outcome.pr,
                linkedPRNumber,
                requestHeadOid
              })
            ) {
              divergedLinkedPRClears.push({
                worktreeId: alias.worktreeId,
                linkedPRNumber,
                branch: alias.branch,
                requestHeadOid,
                scope
              })
            } else if (
              scope &&
              worktree &&
              linkedPRNumber != null &&
              shouldClearBranchMismatchedLinkedOpenPR({
                pr: event.outcome.pr,
                linkedPRNumber,
                branch: alias.branch,
                requestHeadOid,
                pushTargetBranch: worktree.pushTarget?.branchName ?? null
              })
            ) {
              branchMismatchedLinkedPRClears.push({
                worktreeId: alias.worktreeId,
                linkedPRNumber,
                branch: alias.branch,
                requestHeadOid,
                scope
              })
            }
          }
          const nextCaches = applyGitHubPRResultToCaches({
            prCache: nextPRCache,
            hostedReviewCache: nextHostedReviewCache,
            prCacheKey: alias.cacheKey,
            repoPath: alias.repoPath,
            branch: alias.branch,
            settings: s.settings,
            repoId: alias.repoId,
            connectionId: alias.connectionId,
            executionHostId: aliasExecutionHostId,
            hasRepoOwner: true,
            pr: data,
            fetchedAt: event.outcome.fetchedAt,
            rejectedPRUrls:
              event.outcome.kind === 'no-pr' ? event.outcome.rejectedPRUrls : undefined,
            fetchedHeadOid: alias.currentHeadOid,
            state: s,
            worktreeId: alias.worktreeId,
            linkedPRNumber: alias.linkedPRNumber,
            fallbackPRNumber: alias.fallbackPRNumber,
            fallbackPRSource: alias.fallbackPRSource,
            requestStartedAt: event.requestStartedAt,
            requestStartedEntry
          })
          nextPRCache = nextCaches.prCache
          nextHostedReviewCache = nextCaches.hostedReviewCache
          continue
        }

        if (event.status) {
          if (previousSequence !== event.sequence) {
            deletePRRefreshStartedEntry(previousSequence, alias.cacheKey)
          }
          if (event.status === 'in-flight' && event.requestStartedAt !== undefined) {
            const hostedReviewCacheKey = getHostedReviewCacheKey(
              alias.repoPath,
              alias.branch,
              s.settings,
              alias.repoId,
              alias.connectionId,
              aliasExecutionHostId,
              true
            )
            setPRRefreshStartedEntry(
              event.sequence,
              alias.cacheKey,
              s.hostedReviewCache[hostedReviewCacheKey],
              alias.linkedPRNumber != null
                ? captureLinkedReviewClearScope(
                    s,
                    alias.worktreeId,
                    getGitHubRepoLookupIndex(s.repos).findOnHost(
                      aliasExecutionHostId,
                      alias.repoId,
                      alias.repoPath
                    )
                  )
                : undefined
            )
          } else {
            // Why: pause/skip can follow an in-flight broadcast with no outcome; drop the stale request-start snapshot.
            deletePRRefreshStartedEntry(event.sequence, alias.cacheKey)
          }
          // Why: delete-then-set re-orders this key last so capRecordByInsertionOrder evicts idle, not active, keys.
          delete nextStates[alias.cacheKey]
          const isPaused = event.status === 'paused'
          nextStates[alias.cacheKey] = {
            status: event.status,
            reason: event.reason,
            updatedAt: Date.now(),
            pausedUntil: event.pausedUntil,
            skippedReason: event.skippedReason,
            // Why: paused = rate-limit gate; map pausedUntil into the schedule to show auto-retry and disable manual Retry.
            nextAutoRetryAt: isPaused ? event.pausedUntil : undefined,
            retryDisabledUntil: isPaused ? event.pausedUntil : undefined
          }
        }
      }

      // Preserve root identity so no-op writes do not notify every store subscriber.
      return changed
        ? {
            prRefreshSequences: capPrRefreshSequences(nextSequences),
            // Why: bound prRefreshStates with status-aware eviction so visible in-progress pills survive.
            prRefreshStates: capPrRefreshStates(nextStates),
            prCache: nextPRCache,
            hostedReviewCache: nextHostedReviewCache
          }
        : s
    })
    for (const clear of divergedLinkedPRClears) {
      clearLinkedReview(get, clear.scope, clear, 'diverged')
    }
    for (const clear of branchMismatchedLinkedPRClears) {
      clearLinkedReview(get, clear.scope, clear, 'branch-mismatch')
    }
  }
})
