import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import { applyCachedChecksStatus } from './pr-check-status-cache'
import { debouncedSaveCache } from './cache-persistence'
import {
  capPrRefreshSequences,
  capPrRefreshStates,
  pruneExpiredPRRefreshStates
} from './pr-refresh-state'
import {
  applyGitHubPRResultToCaches,
  deletePRRefreshStartedEntry,
  prRefreshStartedEntryKey,
  setPRRefreshStartedHostedReviewEntry
} from './pr-result-cache'
import { prRefreshStartedHostedReviewEntries } from './request-coordination'
import { getRefreshAliasExecutionHostId } from './repository-routing'
import {
  buildWorktreeLookupIndex,
  findUniqueWorktreeById,
  isStaleExactLinkedPRLookup,
  shouldApplyBranchMismatchedLinkedPRClear,
  shouldApplyDivergedLinkedPRClear,
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from './worktree-refresh'
import type { WorktreeLookupIndex } from './worktree-refresh'

export const createRefreshEventActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'applyGitHubPRRefreshEvent'> => ({
  applyGitHubPRRefreshEvent: (event) => {
    // Why: local-repo sidebar refresh routes through the main PR coordinator, so run the same guarded diverged-merged-PR clear.
    const divergedLinkedPRClears: {
      worktreeId: string
      linkedPRNumber: number
      branch: string
      requestHeadOid: string | null
      executionHostId: string
    }[] = []
    const branchMismatchedLinkedPRClears: {
      worktreeId: string
      linkedPRNumber: number
      branch: string
      requestHeadOid: string | null
      executionHostId: string
    }[] = []
    let didUpdatePRCache = false
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
        const previousSequence = nextSequences[alias.cacheKey] ?? 0
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
          prRefreshStartedHostedReviewEntries.delete(startedEntryKey)
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
            isStaleExactLinkedPRLookup(s, alias.worktreeId, linkedPRNumber, worktreeLookupIndex)
          ) {
            continue
          }
          if (event.outcome.kind === 'found' && alias.worktreeId) {
            const requestHeadOid = alias.currentHeadOid ?? null
            const worktree =
              linkedPRNumber != null
                ? findUniqueWorktreeById(
                    s,
                    alias.worktreeId,
                    aliasExecutionHostId,
                    worktreeLookupIndex
                  )
                : null
            // Why: only the sequence-gate winner owns metadata side effects; late outcomes must not unlink a newer PR.
            if (
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
                executionHostId: aliasExecutionHostId
              })
            } else if (
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
                executionHostId: aliasExecutionHostId
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
            state: s,
            worktreeId: alias.worktreeId,
            linkedPRNumber: alias.linkedPRNumber,
            fallbackPRNumber: alias.fallbackPRNumber,
            fallbackPRSource: alias.fallbackPRSource,
            requestStartedAt: event.requestStartedAt,
            requestStartedEntry
          })
          didUpdatePRCache = didUpdatePRCache || nextCaches.prCache !== nextPRCache
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
            setPRRefreshStartedHostedReviewEntry(
              prRefreshStartedEntryKey(event.sequence, alias.cacheKey),
              s.hostedReviewCache[hostedReviewCacheKey]
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

      return changed
        ? {
            prRefreshSequences: capPrRefreshSequences(nextSequences),
            // Why: bound prRefreshStates with status-aware eviction so visible in-progress pills survive.
            prRefreshStates: capPrRefreshStates(nextStates),
            prCache: nextPRCache,
            hostedReviewCache: nextHostedReviewCache
          }
        : {}
    })
    if (didUpdatePRCache && event.outcome && event.outcome.kind !== 'upstream-error') {
      debouncedSaveCache(get())
    }
    for (const clear of divergedLinkedPRClears) {
      void get().updateWorktreeMeta(
        clear.worktreeId,
        { linkedPR: null },
        {
          shouldApply: () =>
            shouldApplyDivergedLinkedPRClear({
              worktree:
                findUniqueWorktreeById(get(), clear.worktreeId, clear.executionHostId) ?? undefined,
              linkedPRNumber: clear.linkedPRNumber,
              branch: clear.branch,
              requestHeadOid: clear.requestHeadOid
            })
        }
      )
    }
    for (const clear of branchMismatchedLinkedPRClears) {
      void get().updateWorktreeMeta(
        clear.worktreeId,
        { linkedPR: null },
        {
          shouldApply: () =>
            shouldApplyBranchMismatchedLinkedPRClear({
              worktree:
                findUniqueWorktreeById(get(), clear.worktreeId, clear.executionHostId) ?? undefined,
              linkedPRNumber: clear.linkedPRNumber,
              branch: clear.branch,
              requestHeadOid: clear.requestHeadOid
            })
        }
      )
    }
  }
})
