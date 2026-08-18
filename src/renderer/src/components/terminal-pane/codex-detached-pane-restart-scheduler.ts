import { useAppStore } from '@/store'
import {
  resetDetachedCodexPaneRestartClaimsForTests,
  sweepUnclaimedCodexPaneRestarts
} from './codex-detached-pane-restart'

let executorInstalled = false
let executorGeneration = 0
let sweepQueued = false
let sweepRunning = false
let sweepRequestedAfterRun = false

export function hasAddedPendingCodexPaneRestart(
  current: Record<string, true>,
  previous: Record<string, true>
): boolean {
  if (current === previous) {
    return false
  }
  return Object.keys(current).some((ptyId) => !previous[ptyId])
}

/** Installed once at app startup; returns the uninstaller (tests). */
export function installCodexDetachedPaneRestartExecutor(): () => void {
  executorInstalled = true
  const generation = ++executorGeneration
  const unsubscribe = useAppStore.subscribe((state, previousState) => {
    if (
      hasAddedPendingCodexPaneRestart(
        state.pendingCodexPaneRestartIds,
        previousState.pendingCodexPaneRestartIds
      )
    ) {
      scheduleClaimSweep()
    }
  })
  scheduleClaimSweep()
  return () => {
    unsubscribe()
    if (executorGeneration === generation) {
      executorInstalled = false
      executorGeneration += 1
      sweepQueued = false
      sweepRequestedAfterRun = false
    }
  }
}

export function resetCodexDetachedPaneRestartExecutorForTests(): void {
  executorInstalled = false
  executorGeneration += 1
  sweepQueued = false
  sweepRunning = false
  sweepRequestedAfterRun = false
  resetDetachedCodexPaneRestartClaimsForTests()
}

function scheduleClaimSweep(): void {
  if (!executorInstalled) {
    return
  }
  if (sweepRunning) {
    sweepRequestedAfterRun = true
    return
  }
  if (sweepQueued) {
    return
  }
  sweepQueued = true
  const generation = executorGeneration
  // Exact mounted-owner checks fence the claim; a microtask only exits the store write.
  queueMicrotask(() => {
    if (!executorInstalled || executorGeneration !== generation) {
      return
    }
    sweepQueued = false
    if (sweepRunning) {
      sweepRequestedAfterRun = true
      return
    }
    sweepRunning = true
    void sweepUnclaimedCodexPaneRestarts()
      .catch((err) => {
        console.warn('[codex-restart] detached restart sweep failed:', err)
      })
      .finally(() => {
        sweepRunning = false
        if (executorInstalled && sweepRequestedAfterRun) {
          sweepRequestedAfterRun = false
          scheduleClaimSweep()
        }
      })
  })
}
