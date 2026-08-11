import type { ManagedPane } from './pane-manager-types'

export type DeferredFitContinuation = {
  continuation: () => void
  shouldContinue: () => boolean
}

type PaneTerminal = ManagedPane['terminal']

// Why: a continuation parked on `pendingSafeFitContinuations` also holds its awaiting
// caller — reattach keeps live PTY bytes behind that promise. A pane that is display:none
// may not become measurable for minutes (a restored floating workspace stays closed until
// the user opens it), so its completion must resolve now while the work it carried — the
// client-grid push and its SIGWINCH — survives to the first measurable fit.
//
// Why keyed on the terminal, not the pane: a PTY connection holds the toPublicPane()
// wrapper it was created with, while PaneManager drains via its internal panes, so park and
// drain are never the same object. `terminal` is carried by reference and dies with the pane.
// Same trap as pane-metric-options-deferral.
const deferredByTerminal = new WeakMap<PaneTerminal, Map<string, DeferredFitContinuation>>()

export function deferFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  entry: DeferredFitContinuation
): void {
  const deferred =
    deferredByTerminal.get(pane.terminal) ?? new Map<string, DeferredFitContinuation>()
  // Same key replaces: a newer reattach owns the grid the older one was going to send.
  deferred.set(operationKey, entry)
  deferredByTerminal.set(pane.terminal, deferred)
}

export function flushDeferredFitContinuations(pane: ManagedPane): void {
  const deferred = deferredByTerminal.get(pane.terminal)
  if (!deferred) {
    return
  }
  // Why delete first: a continuation can fit again re-entrantly, and it must not re-run itself.
  deferredByTerminal.delete(pane.terminal)
  for (const entry of deferred.values()) {
    if (!entry.shouldContinue()) {
      continue
    }
    try {
      entry.continuation()
    } catch {
      // Why: one superseded pane must not strand the rest of the bucket.
    }
  }
}

export function clearDeferredFitContinuations(pane: ManagedPane): void {
  deferredByTerminal.delete(pane.terminal)
}

// Why: a caller re-registering or cancelling one operation must not leave that operation's
// older deferred twin armed — it would fire alongside the new one on the next fit.
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
