import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadSessionCommitDrafts,
  saveSessionCommitDrafts
} from '@/lib/source-control-commit-draft-session'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { SourceControlActionError } from '../sync/action-error'
import {
  createPrIntentCurrentTargetConflictsWithToken,
  type CreatePrIntentRunToken
} from '../review/create-pr-intent-flow'
import type { CreatePrIntentNotice } from '../commit/commit-area-types'
import { readCommitDraftForWorktree, type CommitDraftsByWorktree } from '../commit/commit-drafts'
import { clearRemoteActionErrorsForCompletedConflictOperations } from '../sync/remote-refresh'

/**
 * Owns every per-worktree record the panel keeps outside the store — commit drafts and errors,
 * remote-action errors, and the in-flight flags for commit, abort, generation and Create PR —
 * together with the pruning that drops records for worktrees that no longer exist.
 */
export function useSourceControlWorktreeOperationState({
  activeWorktreeId,
  conflictOperationsByWorktree,
  worktreeMap
}: {
  activeWorktreeId: string | null
  conflictOperationsByWorktree: Record<string, GitConflictOperation>
  worktreeMap: ReadonlyMap<string, unknown>
}) {
  // Why: setState is async, so a double-click can pass the isCommitting guard before re-render; a synchronously-flipped ref gives a true single-flight lock.
  const commitInFlightRef = useRef<Record<string, boolean>>({})
  // Why: Source Control unmounts on tab switch; keep commit drafts in a module-scoped session cache and restore on remount.
  const [commitDrafts, setCommitDrafts] = useState<CommitDraftsByWorktree>(() =>
    loadSessionCommitDrafts()
  )
  const commitDraftsRef = useRef<CommitDraftsByWorktree>(commitDrafts)
  const commitErrorsRef = useRef<Record<string, string | null>>({})
  const [commitErrors, setCommitErrors] = useState<Record<string, string | null>>({})
  const [remoteActionErrors, setRemoteActionErrors] = useState<
    Record<string, SourceControlActionError | null>
  >({})
  const remoteActionErrorSequenceByWorktreeRef = useRef<Record<string, number>>({})
  const previousConflictOperationsRef = useRef<Record<string, GitConflictOperation>>({})
  // Why: keep commit-in-flight per-worktree; a single boolean would clear on worktree switch, allowing a double-commit on the original.
  const [commitInFlightByWorktree, setCommitInFlightByWorktree] = useState<Record<string, boolean>>(
    {}
  )
  const [abortOperationInFlightByWorktree, setAbortOperationInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [advanceOperationInFlightByWorktree, setAdvanceOperationInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const isAbortingOperation = abortOperationInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const isAdvancingOperation = advanceOperationInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const isCommitting = commitInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  // Why: per-worktree shape (like commit) so navigating worktrees mid-generation never cancels the in-flight request.
  const generateInFlightRef = useRef<Record<string, boolean>>({})
  const [generateInFlightByWorktree, setGenerateInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [generateErrors, setGenerateErrors] = useState<Record<string, string | null>>({})
  const createPrInFlightRef = useRef<Record<string, boolean>>({})
  const [createPrInFlightByWorktree, setCreatePrInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const isCreatingPr = createPrInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const createPrIntentInFlightRef = useRef<Record<string, boolean>>({})
  const createPrIntentRunTokenRef = useRef<Record<string, CreatePrIntentRunToken | null>>({})
  const createPrIntentCurrentTargetRef = useRef({
    repoId: null as string | null,
    worktreeId: null as string | null,
    worktreePath: null as string | null,
    branch: null as string | null,
    baseRef: null as string | null
  })
  const [createPrIntentInFlightByWorktree, setCreatePrIntentInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const [createPrIntentNotices, setCreatePrIntentNotices] = useState<
    Record<string, CreatePrIntentNotice | null>
  >({})
  const isCreatePrIntentInFlight = createPrIntentInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const createPrIntentNotice = createPrIntentNotices[activeWorktreeId ?? ''] ?? null
  const setCreatePrIntentNoticeForWorktree = useCallback(
    (worktreeId: string, notice: CreatePrIntentNotice | null): void => {
      setCreatePrIntentNotices((prev) => ({ ...prev, [worktreeId]: notice }))
    },
    []
  )
  const createPrIntentRunStillOwnsWorktree = useCallback(
    (token: CreatePrIntentRunToken): boolean =>
      createPrIntentRunTokenRef.current[token.worktreeId] === token,
    []
  )
  const createPrIntentActiveTargetConflicts = useCallback(
    (token: CreatePrIntentRunToken): boolean =>
      createPrIntentCurrentTargetConflictsWithToken(token, createPrIntentCurrentTargetRef.current),
    []
  )

  const commitMessage = readCommitDraftForWorktree(commitDrafts, activeWorktreeId)
  const commitError = commitErrors[activeWorktreeId ?? ''] ?? null
  const remoteActionError = remoteActionErrors[activeWorktreeId ?? ''] ?? null
  const activeRemoteActionSequence = activeWorktreeId
    ? (remoteActionErrorSequenceByWorktreeRef.current[activeWorktreeId] ?? null)
    : null

  useEffect(() => {
    commitDraftsRef.current = commitDrafts
  }, [commitDrafts])

  const updateCommitDrafts = useCallback(
    (updater: (drafts: CommitDraftsByWorktree) => CommitDraftsByWorktree): void => {
      const next = updater(commitDraftsRef.current)
      // Why: Create PR intent reads this ref after awaits so it doesn't overwrite user edits made before React's passive state sync runs.
      commitDraftsRef.current = next
      setCommitDrafts(next)
    },
    []
  )
  const setCommitErrorForWorktree = useCallback(
    (worktreeId: string, message: string | null): void => {
      commitErrorsRef.current = { ...commitErrorsRef.current, [worktreeId]: message }
      setCommitErrors((prev) => ({ ...prev, [worktreeId]: message }))
    },
    []
  )

  // Why: prune per-worktree state for removed worktrees so a reused ID doesn't inherit stale state (e.g. a stuck commitInFlightRef disabling Commit).
  useEffect(() => {
    const pruneRecord = <T>(prev: Record<string, T>): Record<string, T> => {
      let changed = false
      const next: Record<string, T> = {}
      for (const key of Object.keys(prev)) {
        if (worktreeMap.has(key)) {
          next[key] = prev[key]
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    }
    updateCommitDrafts((prev) => pruneRecord(prev))
    commitErrorsRef.current = pruneRecord(commitErrorsRef.current)
    setCommitErrors((prev) => pruneRecord(prev))
    setRemoteActionErrors((prev) => pruneRecord(prev))
    setCommitInFlightByWorktree((prev) => pruneRecord(prev))
    setAbortOperationInFlightByWorktree((prev) => pruneRecord(prev))
    setAdvanceOperationInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateErrors((prev) => pruneRecord(prev))
    setCreatePrIntentInFlightByWorktree((prev) => pruneRecord(prev))
    setCreatePrIntentNotices((prev) => pruneRecord(prev))
    // Refs don't need setState — mutate in place to drop stale keys.
    for (const key of Object.keys(commitInFlightRef.current)) {
      if (!worktreeMap.has(key)) {
        delete commitInFlightRef.current[key]
      }
    }
    for (const key of Object.keys(remoteActionErrorSequenceByWorktreeRef.current)) {
      if (!worktreeMap.has(key)) {
        delete remoteActionErrorSequenceByWorktreeRef.current[key]
      }
    }
    for (const key of Object.keys(generateInFlightRef.current)) {
      if (!worktreeMap.has(key)) {
        delete generateInFlightRef.current[key]
      }
    }
    for (const key of Object.keys(createPrIntentInFlightRef.current)) {
      if (!worktreeMap.has(key)) {
        delete createPrIntentInFlightRef.current[key]
        delete createPrIntentRunTokenRef.current[key]
      }
    }
  }, [updateCommitDrafts, worktreeMap])

  useEffect(() => {
    saveSessionCommitDrafts(commitDrafts)
  }, [commitDrafts])

  useEffect(() => {
    // Why: conflicts are often resolved in a terminal; clear the stale failure banner once git status sees the operation end.
    const previousConflictOperations = previousConflictOperationsRef.current
    setRemoteActionErrors((prev) =>
      clearRemoteActionErrorsForCompletedConflictOperations({
        remoteActionErrors: prev,
        previousConflictOperations,
        currentConflictOperations: conflictOperationsByWorktree
      })
    )
    previousConflictOperationsRef.current = conflictOperationsByWorktree
  }, [conflictOperationsByWorktree])

  return {
    abortOperationInFlightByWorktree,
    advanceOperationInFlightByWorktree,
    activeRemoteActionSequence,
    commitDraftsRef,
    commitError,
    commitErrorsRef,
    commitInFlightRef,
    commitMessage,
    createPrInFlightRef,
    createPrIntentActiveTargetConflicts,
    createPrIntentCurrentTargetRef,
    createPrIntentInFlightRef,
    createPrIntentNotice,
    createPrIntentRunStillOwnsWorktree,
    createPrIntentRunTokenRef,
    generateErrors,
    generateInFlightByWorktree,
    generateInFlightRef,
    isAbortingOperation,
    isAdvancingOperation,
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    remoteActionError,
    remoteActionErrorSequenceByWorktreeRef,
    setAbortOperationInFlightByWorktree,
    setAdvanceOperationInFlightByWorktree,
    setCommitErrorForWorktree,
    setCommitInFlightByWorktree,
    setCreatePrInFlightByWorktree,
    setCreatePrIntentInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    setGenerateErrors,
    setGenerateInFlightByWorktree,
    setRemoteActionErrors,
    updateCommitDrafts
  }
}

export type SourceControlWorktreeOperationState = ReturnType<
  typeof useSourceControlWorktreeOperationState
>
