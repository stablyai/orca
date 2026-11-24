/** Mount hidden siblings on idle frames so activation paints at visible-pane cost while preserving its warm working set. */

// Match the former eager limit: over-cap worktrees keep hidden tabs unmounted, preserving steady-state pane/GPU/heap usage.
export const ACTIVATION_DEFERRED_ADMISSION_LIMIT = 4

// The timeout guarantees admission even when continuous output prevents idle frames.
export const ACTIVATION_DEFERRED_ADMISSION_IDLE_TIMEOUT_MS = 250

// Keyed by restriction identity: any reveal or new plan replaces the set, so a stale mark can't outlive it.
const drainedRestrictions = new WeakSet<ReadonlySet<string>>()

/** Admission found only unbound restored tabs left; they wait until shown, so admission is done for this restriction. */
export function markActivationAdmissionDrained(restriction: ReadonlySet<string>): boolean {
  if (drainedRestrictions.has(restriction)) {
    return false
  }
  drainedRestrictions.add(restriction)
  return true
}

export function hasPendingBackgroundMounts(restriction: ReadonlySet<string> | null): boolean {
  return restriction !== null && !drainedRestrictions.has(restriction)
}

export function isActivationAdmissionEligible(deferredTabCount: number): boolean {
  return deferredTabCount > 0 && deferredTabCount <= ACTIVATION_DEFERRED_ADMISSION_LIMIT
}

export function pickNextActivationDeferredTabId(
  allTabIds: readonly string[],
  deferredTabIds: ReadonlySet<string> | null | undefined
): string | null {
  if (!deferredTabIds || deferredTabIds.size === 0) {
    return null
  }
  for (const tabId of allTabIds) {
    if (deferredTabIds.has(tabId)) {
      return tabId
    }
  }
  return null
}

/** Yield to the reveal’s foreground restore before warming hidden tabs. */
export function scheduleActivationDeferredAdmission(callback: () => void): () => void {
  const requestIdle = globalThis.requestIdleCallback
  const cancelIdle = globalThis.cancelIdleCallback
  if (typeof requestIdle !== 'function' || typeof cancelIdle !== 'function') {
    const timer = globalThis.setTimeout(callback, 0)
    return () => globalThis.clearTimeout(timer)
  }
  const handle = requestIdle(() => callback(), {
    timeout: ACTIVATION_DEFERRED_ADMISSION_IDLE_TIMEOUT_MS
  })
  return () => cancelIdle(handle)
}
