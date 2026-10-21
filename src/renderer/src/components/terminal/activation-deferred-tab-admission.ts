/**
 * Idle-frame admission of the tabs a worktree activation deferred.
 *
 * Why: activation mounts only what the user can see, so the switch paints at
 * one-pane cost. The hidden siblings still belong in the warm working set —
 * admitting them one per idle frame restores the pre-deferral steady state
 * without putting any of it on the switch's critical path.
 */

// Why a cap, and why exactly this number: before deferral shrank to "visible
// only", an activation eagerly mounted its hidden tabs whenever no more than
// four of them were deferrable, and left the rest unmounted for good. Admission
// reproduces that warm set and never exceeds it — a worktree that deferred more
// than this at activation keeps every deferred tab unmounted, exactly as it did
// before. So the steady-state pane, WebGL-context and heap population is
// unchanged; only the frame the mounts land on moved.
export const ACTIVATION_DEFERRED_ADMISSION_LIMIT = 4

// Why a timeout: a renderer that never goes idle (an agent flooding a pane)
// must still finish admitting, or those tabs stay unmounted until the next visit.
export const ACTIVATION_DEFERRED_ADMISSION_IDLE_TIMEOUT_MS = 250

/** Whether an activation's deferred population is small enough to warm up in the background. */
export function isActivationAdmissionEligible(deferredTabCount: number): boolean {
  return deferredTabCount > 0 && deferredTabCount <= ACTIVATION_DEFERRED_ADMISSION_LIMIT
}

/** Next deferred tab in tab order, so admission follows the tab bar the user reads. */
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

/**
 * Runs `callback` on an idle frame. Idle is the whole scheduling contract: the
 * reveal's own restore is foreground work, so it takes the frame first and
 * warm-up cannot contend with the paint it exists to serve.
 */
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
