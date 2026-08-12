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
  // Why opt-in: only the reattach grid push is still owed after an indefinite hide. Every
  // other caller keeps the bounded-degradation contract and is dropped when unmeasurable.
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
  // Why: this registration owns the key now, so an earlier deferred twin must not survive to
  // fire alongside it on the next fit.
  clearDeferredFitContinuation(pane, operationKey)
  const currentOperations = pendingSafeFitContinuations.get(pane) ?? operations
  currentOperations.set(operationKey, pending)
  pendingSafeFitContinuations.set(pane, currentOperations)
}

export function flushPendingSafeFitContinuations(pane: ManagedPane): void {
  // Why first: continuations deferred while the pane was display:none carry the reattach
  // grid push, and the pane is measurable exactly now. Reading the pending map afterwards is
  // what keeps a continuation that fits re-entrantly from re-running a settled entry.
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

// Why settle-then-defer rather than settle: the awaiting caller must be released now, but the
// grid push the continuation carries is still owed to the PTY once the pane measures.
export function releaseSafeFitContinuationUntilMeasurable(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation
): void {
  // Why gate on the settle: a superseded entry is already owned by a newer registration, and
  // re-parking it would resurrect work that caller deliberately replaced.
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
  // Why: this is pane teardown/rebuild — a grid push owed to the old pane is now meaningless.
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
  // Why identity-gated: a stale handle may cancel after a replacement with the same key parks;
  // it must invalidate its own deferred work without deleting the newer grid push.
  clearDeferredFitContinuation(pane, operationKey, pending)
}
