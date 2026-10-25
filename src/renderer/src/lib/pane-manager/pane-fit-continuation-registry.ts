import type { ManagedPane } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import { clearPaneFitContinuationRetry } from './pane-fit-continuation-retry'
import {
  clearDeferredFitContinuation,
  clearDeferredFitContinuations,
  deferFitContinuation,
  flushDeferredFitContinuations
} from './pane-fit-deferred-continuations'

export type PendingSafeFitContinuation = {
  continuation: () => void
  shouldContinue: () => boolean
  resolve: (completed: boolean) => void
  // Only reattach grid pushes survive indefinite hiding; other unmeasurable callers retain bounded completion.
  deferIfHidden: boolean
}

const pendingSafeFitContinuations = new WeakMap<
  ManagedPane,
  Map<string, PendingSafeFitContinuation>
>()

export function hasPendingSafeFitContinuations(pane: ManagedPane): boolean {
  return Boolean(pendingSafeFitContinuations.get(pane)?.size)
}

export function isPendingSafeFitContinuationCurrent(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation
): boolean {
  return pendingSafeFitContinuations.get(pane)?.get(operationKey) === pending
}

/** Returns false when a newer registration already owns the key. */
export function settlePendingSafeFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation,
  completed: boolean
): boolean {
  const operations = pendingSafeFitContinuations.get(pane)
  if (operations?.get(operationKey) !== pending) {
    return false
  }
  operations.delete(operationKey)
  if (operations.size === 0) {
    pendingSafeFitContinuations.delete(pane)
    clearPaneFitContinuationRetry(pane)
  }
  pending.resolve(completed)
  return true
}

export function registerPendingSafeFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation
): void {
  const operations = pendingSafeFitContinuations.get(pane) ?? new Map()
  const replaced = operations.get(operationKey)
  if (replaced) {
    settlePendingSafeFitContinuation(pane, operationKey, replaced, false)
  }
  // New ownership must disarm the older deferred twin or both fire on the next fit.
  clearDeferredFitContinuation(pane, operationKey)
  const currentOperations = pendingSafeFitContinuations.get(pane) ?? operations
  currentOperations.set(operationKey, pending)
  pendingSafeFitContinuations.set(pane, currentOperations)
}

export function flushPendingSafeFitContinuations(pane: ManagedPane): void {
  // Drain deferred grid pushes now the pane measures, before reading pending entries that reentrant fits may settle.
  flushDeferredFitContinuations(pane)
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  for (const [operationKey, pending] of operations) {
    if (!pending.shouldContinue()) {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
      continue
    }
    try {
      pending.continuation()
      settlePendingSafeFitContinuation(pane, operationKey, pending, true)
    } catch {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
    }
  }
}

// Release the awaiting caller now, but preserve the owed PTY grid push until the pane measures.
export function releaseSafeFitContinuationUntilMeasurable(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation
): void {
  // A superseded entry belongs to its replacement; re-parking would resurrect stale work.
  if (
    settlePendingSafeFitContinuation(pane, operationKey, pending, false) &&
    pending.deferIfHidden
  ) {
    deferFitContinuation(pane, operationKey, pending)
  }
}

export function pruneStaleSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  for (const [operationKey, pending] of operations) {
    if (!pending.shouldContinue()) {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
    } else if (isManagedPaneDisplayNone(pane)) {
      releaseSafeFitContinuationUntilMeasurable(pane, operationKey, pending)
    }
  }
}

export function failPendingSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  for (const [operationKey, pending] of Array.from(operations.entries())) {
    settlePendingSafeFitContinuation(pane, operationKey, pending, false)
  }
}

export function cancelPendingSafeFitContinuations(pane: ManagedPane): void {
  clearPaneFitContinuationRetry(pane)
  // Teardown/rebuild invalidates grid pushes owed to the old pane.
  clearDeferredFitContinuations(pane)
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  pendingSafeFitContinuations.delete(pane)
  for (const pending of operations.values()) {
    pending.resolve(false)
  }
}

export function cancelPendingSafeFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation
): void {
  settlePendingSafeFitContinuation(pane, operationKey, pending, false)
  // Cancel only this owner’s deferred work; a same-key replacement may already be parked.
  clearDeferredFitContinuation(pane, operationKey, pending)
}
