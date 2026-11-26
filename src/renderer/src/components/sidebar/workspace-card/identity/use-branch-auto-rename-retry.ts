import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  BranchAutoRenameOutcome,
  BranchAutoRenameRetryResult
} from '../../../../../../shared/worktree/branch-auto-rename-attempt'
import {
  getAutoNameRetryAvailability,
  retryAutoName,
  waitForAutoNameAttempt
} from './branch-auto-rename-actions'

/**
 * How long the dialog waits on one attempt before handing its controls back. The attempt itself keeps
 * running in main, and its verdict still applies if it arrives later.
 */
export const BRANCH_AUTO_RENAME_OBSERVATION_MS = 90_000

const INTERRUPTED: BranchAutoRenameOutcome = { kind: 'deferred', reason: 'interrupted' }

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

/**
 * What the dialog is waiting on. attemptId is null until a started event names it; clickSeq marks the click
 * whose reply may settle it. A stalled follow gave the controls back but still accepts its late verdict.
 */
type Follow = {
  attemptId: number | null
  clickSeq: number | null
  observation: number
  stalled: boolean
}

/** Tracks one dialog session's attempts; results from an earlier session, click or attempt are ignored. */
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
  // Bumped on every session start and end, so continuations of a closed or unmounted session do nothing.
  const session = useRef(0)
  const follow = useRef<Follow | null>(null)
  // Attempt ids are monotonic: anything at or below the newest finished id is stale or a duplicate.
  const latestFinished = useRef(0)
  const outcome = useRef<BranchAutoRenameOutcome | null>(null)
  const counters = useRef({ click: 0, observation: 0 })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacks = useRef(args)
  useLayoutEffect(() => {
    callbacks.current = args
  })

  const setFollow = useCallback((next: Follow | null) => {
    follow.current = next
    setRunning(next !== null && !next.stalled)
  }, [])

  const showOutcome = useCallback((next: BranchAutoRenameOutcome | null, at: number | null) => {
    outcome.current = next
    setLastOutcome(next)
    setLastFinishedAt(at)
  }, [])

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // Voids every pending reply and timer of the session that just ended, including after unmount.
  const endSession = useCallback(() => {
    session.current++
    clearTimer()
  }, [clearTimer])

  // Starts a fresh observation budget; when it runs out the controls come back without a verdict.
  const arm = useCallback(
    (token: number) => {
      clearTimer()
      const observation = ++counters.current.observation
      timer.current = setTimeout(() => {
        timer.current = null
        const current = follow.current
        if (token !== session.current || current?.observation !== observation || current.stalled) {
          return
        }
        setFollow({ ...current, stalled: true })
        showOutcome(INTERRUPTED, Date.now())
        callbacks.current.onAttemptFinished(INTERRUPTED)
      }, BRANCH_AUTO_RENAME_OBSERVATION_MS)
      return observation
    },
    [clearTimer, setFollow, showOutcome]
  )

  const adopt = useCallback(
    (attemptId: number, token: number) => {
      setFollow({ attemptId, clickSeq: null, observation: arm(token), stalled: false })
      // A newer attempt supersedes a kept name; retryable results stay visible while it runs.
      if (outcome.current?.kind === 'ineligible') {
        showOutcome(null, null)
      }
    },
    [arm, setFollow, showOutcome]
  )

  const apply = useCallback(
    (result: BranchAutoRenameRetryResult) => {
      clearTimer()
      setFollow(null)
      latestFinished.current = Math.max(latestFinished.current, result.attemptId ?? 0)
      if (result.outcome.kind === 'renamed') {
        callbacks.current.onRenamed()
        return
      }
      showOutcome(result.outcome, result.finishedAt)
      setFinishedCount((count) => count + 1)
      callbacks.current.onAttemptFinished(result.outcome)
    },
    [clearTimer, setFollow, showOutcome]
  )

  const settleClick = useCallback(
    (clickSeq: number, result: BranchAutoRenameRetryResult, token: number) => {
      const current = follow.current
      if (token !== session.current || current === null) {
        return
      }
      if (result.attemptId !== null && result.attemptId === current.attemptId) {
        apply(result)
      } else if (current.clickSeq === clickSeq) {
        if (current.attemptId === null) {
          // The click never learned its attempt id, so only its own reply can settle it.
          apply(result)
        } else {
          // A different attempt was attached since; keep following that one.
          follow.current = { ...current, clickSeq: null }
        }
      }
    },
    [apply]
  )

  const settleAdopted = useCallback(
    (attemptId: number, result: BranchAutoRenameRetryResult | null, token: number) => {
      if (token !== session.current || follow.current?.attemptId !== attemptId) {
        return
      }
      if (result) {
        apply(result)
        return
      }
      // It finished before the wait began; its effects arrive with the workspace's own refresh.
      clearTimer()
      setFollow(null)
      latestFinished.current = Math.max(latestFinished.current, attemptId)
    },
    [apply, clearTimer, setFollow]
  )

  useEffect(() => {
    const token = ++session.current
    follow.current = null
    latestFinished.current = 0
    clearTimer()
    setRunning(false)
    showOutcome(null, null)
    setAvailability('pending')
    if (!open) {
      return
    }
    getAutoNameRetryAvailability({ worktreeId, executionHostId })
      .then((result) => {
        if (token !== session.current) {
          return
        }
        // An attempt observed meanwhile is newer than this snapshot.
        const resolved = result.available ? 'available' : 'unavailable'
        setAvailability((current) => (current === 'pending' ? resolved : current))
        // A completion that arrived before this reply already settled that attempt.
        if (
          result.runningAttemptId !== null &&
          result.runningAttemptId > latestFinished.current &&
          follow.current === null
        ) {
          const attemptId = result.runningAttemptId
          adopt(attemptId, token)
          // The host that runs the attempt reports its end; remote hosts send no attempt events.
          void waitForAutoNameAttempt({ worktreeId, executionHostId }, attemptId)
            .then((finished) => settleAdopted(attemptId, finished, token))
            .catch(() => {})
        }
      })
      .catch(() => {
        if (token === session.current) {
          setAvailability((current) => (current === 'pending' ? 'unavailable' : current))
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
      const current = follow.current
      if (event.phase === 'finished') {
        if (current?.attemptId === event.attemptId) {
          apply({
            attemptId: event.attemptId,
            outcome: event.outcome,
            finishedAt: event.finishedAt
          })
        } else {
          latestFinished.current = Math.max(latestFinished.current, event.attemptId)
        }
        return
      }
      if (event.attemptId <= latestFinished.current) {
        return
      }
      if (current === null || (current.stalled && event.attemptId > (current.attemptId ?? 0))) {
        adopt(event.attemptId, token)
      } else if (current.stalled) {
        return
      } else if (current.attemptId === null) {
        follow.current = { ...current, attemptId: event.attemptId }
      } else if (event.attemptId > current.attemptId) {
        adopt(event.attemptId, token)
      } else {
        return
      }
      // A running local attempt is retryable in main, whatever an earlier snapshot said.
      setAvailability('available')
    })
    return () => {
      endSession()
      unsubscribe()
    }
  }, [
    adopt,
    apply,
    clearTimer,
    endSession,
    executionHostId,
    open,
    settleAdopted,
    showOutcome,
    worktreeId
  ])

  const tryAgain = useCallback(() => {
    if (follow.current !== null && !follow.current.stalled) {
      return
    }
    const token = session.current
    const clickSeq = ++counters.current.click
    setFollow({ attemptId: null, clickSeq, observation: arm(token), stalled: false })
    retryAutoName({ worktreeId, executionHostId })
      .then((result) => settleClick(clickSeq, result, token))
      .catch(() =>
        settleClick(
          clickSeq,
          { attemptId: null, outcome: INTERRUPTED, finishedAt: Date.now() },
          token
        )
      )
  }, [arm, executionHostId, settleClick, setFollow, worktreeId])

  return { availability, running, lastOutcome, lastFinishedAt, finishedCount, tryAgain }
}
