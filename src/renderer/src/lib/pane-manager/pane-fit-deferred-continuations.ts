import type { ManagedPane } from './pane-manager-types'

export type DeferredFitContinuation = {
  continuation: () => void
  shouldContinue: () => boolean
}

type PaneTerminal = ManagedPane['terminal']

/** Hidden reattach must release live output immediately but retain its PTY grid push/SIGWINCH until measurable. Key by terminal: PTY public wrappers and internal manager panes differ by identity (as in pane-metric-options-deferral). */
const deferredByTerminal = new WeakMap<PaneTerminal, Map<string, DeferredFitContinuation>>()

export function deferFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  entry: DeferredFitContinuation
): void {
  const deferred =
    deferredByTerminal.get(pane.terminal) ?? new Map<string, DeferredFitContinuation>()
  // A newer same-key reattach owns the grid push.
  deferred.set(operationKey, entry)
  deferredByTerminal.set(pane.terminal, deferred)
}

export function flushDeferredFitContinuations(pane: ManagedPane): void {
  const deferred = deferredByTerminal.get(pane.terminal)
  if (!deferred) {
    return
  }
  // Delete before invoking so a reentrant fit cannot rerun this continuation.
  deferredByTerminal.delete(pane.terminal)
  for (const entry of deferred.values()) {
    if (!entry.shouldContinue()) {
      continue
    }
    try {
      entry.continuation()
    } catch {
      // A superseded pane must not strand the rest of the bucket.
    }
  }
}

export function clearDeferredFitContinuations(pane: ManagedPane): void {
  deferredByTerminal.delete(pane.terminal)
}

// Re-register/cancel must disarm the older deferred twin or both run on the next fit.
export function clearDeferredFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  expected?: DeferredFitContinuation
): void {
  const deferred = deferredByTerminal.get(pane.terminal)
  if (!deferred) {
    return
  }
  if (expected && deferred.get(operationKey) !== expected) {
    return
  }
  deferred.delete(operationKey)
  if (deferred.size === 0) {
    deferredByTerminal.delete(pane.terminal)
  }
}
