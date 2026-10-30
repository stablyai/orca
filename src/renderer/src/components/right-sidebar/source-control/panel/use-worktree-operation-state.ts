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

/** Prune per-worktree drafts/errors/in-flight records when worktrees disappear so reused IDs inherit no stale state. */
export function useSourceControlWorktreeOperationState({
  activeWorktreeId,
  conflictOperationsByWorktree,
  worktreeMap
}: {
  activeWorktreeId: string | null
  conflictOperationsByWorktree: Record<string, GitConflictOperation>
  worktreeMap: ReadonlyMap<string, unknown>
}) {
  // Latch synchronously because async state cannot block double-clicks before rerender.
  const commitInFlightRef = useRef<Record<string, boolean>>({})
  // Persist drafts in the renderer session cache across Source Control tab unmounts.
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
  // Track commits per worktree so navigation cannot allow a duplicate in-flight commit.
  const [commitInFlightByWorktree, setCommitInFlightByWorktree] = useState<Record<string, boolean>>(
    {}
  )
  const [abortOperationInFlightByWorktree, setAbortOperationInFlightByWorktree] = useState<
    Record<string, boolean>
  >({})
  const isAbortingOperation = abortOperationInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  const isCommitting = commitInFlightByWorktree[activeWorktreeId ?? ''] ?? false
  // Track generation per worktree so navigation cannot cancel its running request.
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
      // Sync the draft ref before passive effects so awaited Create PR flows see current user edits.
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

  // Prune removed worktrees before reused IDs can inherit stuck in-flight state.
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
    setGenerateInFlightByWorktree((prev) => pruneRecord(prev))
    setGenerateErrors((prev) => pruneRecord(prev))
    setCreatePrIntentInFlightByWorktree((prev) => pruneRecord(prev))
    setCreatePrIntentNotices((prev) => pruneRecord(prev))
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
    // Terminal conflict resolution must clear stale failure banners once status observes the operation ending.
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
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    remoteActionError,
    remoteActionErrorSequenceByWorktreeRef,
    setAbortOperationInFlightByWorktree,
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
