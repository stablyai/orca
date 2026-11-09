/** Mount hidden siblings on idle frames so activation paints at visible-pane cost while preserving its warm working set. */

// Match the former eager limit: over-cap worktrees keep hidden tabs unmounted, preserving steady-state pane/GPU/heap usage.
export const ACTIVATION_DEFERRED_ADMISSION_LIMIT = 4

// The timeout guarantees admission even when continuous output prevents idle frames.
export const ACTIVATION_DEFERRED_ADMISSION_IDLE_TIMEOUT_MS = 250

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
