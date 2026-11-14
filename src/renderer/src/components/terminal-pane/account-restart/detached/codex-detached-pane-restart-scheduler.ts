import { useAppStore } from '@/store/index'
import { subscribeMountedTerminalTabChanges } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import {
  resetDetachedCodexPaneRestartClaimsForTests,
  sweepUnclaimedCodexPaneRestarts
} from './codex-detached-pane-restart'

let executorInstalled = false
let executorGeneration = 0
let sweepQueued = false

export function hasAddedPendingCodexPaneRestart(
  current: Record<string, AccountRestartAgent>,
  previous: Record<string, AccountRestartAgent>
): boolean {
  if (current === previous) {
    return false
  }
  return Object.keys(current).some((ptyId) => !previous[ptyId])
}

function hasPendingClaudeRestart(pending: Record<string, AccountRestartAgent>): boolean {
  return Object.values(pending).includes('claude')
}

/** Installed once at app startup; returns the uninstaller (tests). */
export function installCodexDetachedPaneRestartExecutor(): () => void {
  executorInstalled = true
  const generation = ++executorGeneration
  const unsubscribe = useAppStore.subscribe((state, previousState) => {
    if (
      hasAddedPendingCodexPaneRestart(
        state.pendingPaneAccountRestarts,
        previousState.pendingPaneAccountRestarts
      ) ||
      // Why: a deferred Claude restart runs once its turn ends, which only a status change reports.
      (state.agentStatusByPaneKey !== previousState.agentStatusByPaneKey &&
        hasPendingClaudeRestart(state.pendingPaneAccountRestarts))
    ) {
      scheduleClaimSweep()
    }
  })
  // Why: an unmount writes nothing to the store, yet hands its queued Claude restarts to this sweep.
  const unsubscribeMountedTabs = subscribeMountedTerminalTabChanges(() => {
    if (hasPendingClaudeRestart(useAppStore.getState().pendingPaneAccountRestarts)) {
      scheduleClaimSweep()
    }
  })
  scheduleClaimSweep()
  return () => {
    unsubscribe()
    unsubscribeMountedTabs()
    if (executorGeneration === generation) {
      executorInstalled = false
      executorGeneration += 1
      sweepQueued = false
    }
  }
}

export function resetCodexDetachedPaneRestartExecutorForTests(): void {
  executorInstalled = false
  executorGeneration += 1
  sweepQueued = false
  resetDetachedCodexPaneRestartClaimsForTests()
}

function scheduleClaimSweep(): void {
  if (!executorInstalled) {
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
    void sweepUnclaimedCodexPaneRestarts(scheduleClaimSweep).catch((err) => {
      console.warn('[codex-restart] detached restart sweep failed:', err)
    })
  })
}
