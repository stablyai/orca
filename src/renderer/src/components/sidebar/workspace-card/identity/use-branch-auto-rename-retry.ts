import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  BranchAutoRenameOutcome,
  BranchAutoRenameRetryResult
} from '../../../../../../shared/worktree/branch-auto-rename-attempt'

export type BranchAutoRenameRetryState = {
  /** Resolved before the footer paints so Try again never flashes in and out. */
  availability: 'pending' | 'available' | 'unavailable'
  running: boolean
  /** The latest finished attempt's outcome, while the dialog stays open. */
  lastOutcome: BranchAutoRenameOutcome | null
  lastFinishedAt: number | null
  /** Changes per finished attempt so identical errors still reload their output. */
  finishedCount: number
  tryAgain: () => void
}

/** Tracks one dialog session's attempts; results from an earlier session or attempt are ignored. */
export function useBranchAutoRenameRetry(args: {
  open: boolean
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  onRenamed: () => void
  onAttemptFinished: (outcome: BranchAutoRenameOutcome) => void
}): BranchAutoRenameRetryState {
  const { open, worktreeId, executionHostId } = args
  const [availability, setAvailability] =
    useState<BranchAutoRenameRetryState['availability']>('pending')
  const [running, setRunning] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<BranchAutoRenameOutcome | null>(null)
  const [lastFinishedAt, setLastFinishedAt] = useState<number | null>(null)
  const [finishedCount, setFinishedCount] = useState(0)
  const session = useRef(0)
  // 'click' until the started event names the attempt this window launched.
  const tracked = useRef<number | 'click' | null>(null)
  // Attempt ids are monotonic: anything at or below the newest finished id is stale or a duplicate.
  const latestFinished = useRef(0)
  const callbacks = useRef(args)
  useLayoutEffect(() => {
    callbacks.current = args
  })

  const apply = useCallback((result: BranchAutoRenameRetryResult, token: number) => {
    if (token !== session.current) {
      return
    }
    const stale =
      result.attemptId === null
        ? tracked.current !== 'click'
        : tracked.current !== result.attemptId && result.attemptId <= latestFinished.current
    if (stale) {
      return
    }
    latestFinished.current = Math.max(latestFinished.current, result.attemptId ?? 0)
    tracked.current = null
    setRunning(false)
    if (result.outcome.kind === 'renamed') {
      callbacks.current.onRenamed()
      return
    }
    setLastOutcome(result.outcome)
    setLastFinishedAt(result.finishedAt)
    setFinishedCount((count) => count + 1)
    callbacks.current.onAttemptFinished(result.outcome)
  }, [])

  useEffect(() => {
    const token = ++session.current
    tracked.current = null
    latestFinished.current = 0
    setRunning(false)
    setLastOutcome(null)
    setLastFinishedAt(null)
    setAvailability('pending')
    if (!open) {
      return
    }
    let live = true
    window.api.worktrees
      .getBranchAutoRenameRetryAvailability({ worktreeId, executionHostId })
      .then((result) => {
        if (!live) {
          return
        }
        setAvailability(result.available ? 'available' : 'unavailable')
        // A completion that arrived before this reply already settled that attempt.
        if (
          result.runningAttemptId !== null &&
          result.runningAttemptId > latestFinished.current &&
          tracked.current === null
        ) {
          tracked.current = result.runningAttemptId
          setRunning(true)
        }
      })
      .catch(() => {
        if (live) {
          setAvailability('unavailable')
        }
      })
    const unsubscribe = window.api.worktrees.onBranchAutoRenameAttempt((event) => {
      // Only this desktop's own attempts exist; a same-id workspace on another host never follows them.
      if (
        event.executionHostId !== (executionHostId ?? 'local') ||
        event.worktreeId !== worktreeId ||
        token !== session.current
      ) {
        return
      }
      if (event.phase === 'started') {
        if (
          event.attemptId > latestFinished.current &&
          (tracked.current === null ||
            tracked.current === 'click' ||
            event.attemptId > tracked.current)
        ) {
          tracked.current = event.attemptId
          setRunning(true)
        }
        return
      }
      if (tracked.current === event.attemptId) {
        apply(
          { attemptId: event.attemptId, outcome: event.outcome, finishedAt: event.finishedAt },
          token
        )
        return
      }
      latestFinished.current = Math.max(latestFinished.current, event.attemptId)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [apply, executionHostId, open, worktreeId])

  const tryAgain = useCallback(() => {
    if (tracked.current !== null) {
      return
    }
    const token = session.current
    tracked.current = 'click'
    setRunning(true)
    window.api.worktrees
      .retryBranchAutoRename({ worktreeId, executionHostId })
      .then((result) => apply(result, token))
      .catch(() =>
        apply(
          {
            attemptId: null,
            outcome: { kind: 'deferred', reason: 'interrupted' },
            finishedAt: Date.now()
          },
          token
        )
      )
  }, [apply, executionHostId, worktreeId])

  return { availability, running, lastOutcome, lastFinishedAt, finishedCount, tryAgain }
}
