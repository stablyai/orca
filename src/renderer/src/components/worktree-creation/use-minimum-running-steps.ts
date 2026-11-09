import { useEffect, useState } from 'react'
import type { WorktreeSetupStepState } from './worktree-setup-steps'

export const MIN_RUNNING_MS = 400

type Step = {
  id: string
  state: WorktreeSetupStepState
  elapsedMs: number | null
  /** When the step started; null when it never ran or its start is unknown. */
  startedAt: number | null
}

/**
 * Shows each step that ran as running until at least `minMs` after it started, so a fast step
 * never flashes straight from pending to done. Steps after a held one stay pending until it lets go.
 */
export function holdRunningSteps<T extends Step>(
  steps: readonly T[],
  now: number,
  minMs = MIN_RUNNING_MS
): { steps: T[]; wakeAt: number | null } {
  let holding = false
  let wakeAt: number | null = null
  const shown = steps.map((step): T => {
    if (holding && step.state !== 'pending') {
      return { ...step, state: 'pending', elapsedMs: null }
    }
    if (step.state !== 'done' || step.startedAt === null || now >= step.startedAt + minMs) {
      return step
    }
    holding = true
    wakeAt = step.startedAt + minMs
    return { ...step, state: 'running' }
  })
  return { steps: shown, wakeAt }
}

/** `now` is the caller's clock; a timer re-renders when a held step may let go. */
export function useMinimumRunningSteps<T extends Step>(
  steps: readonly T[],
  enabled: boolean,
  now: number
): T[] {
  const [wokeAt, setWokeAt] = useState(0)
  const held = enabled
    ? holdRunningSteps(steps, Math.max(now, wokeAt))
    : { steps: [...steps], wakeAt: null }
  const { wakeAt } = held
  useEffect(() => {
    if (wakeAt === null) {
      return
    }
    const timer = window.setTimeout(
      () => setWokeAt(Math.max(wakeAt, Date.now())),
      Math.max(0, wakeAt - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [wakeAt])
  return held.steps
}
