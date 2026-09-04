// Coalesces preview detaches into one IPC per surface per frame: every
// hand-back main processes re-arms its global resize-suppression window (see
// the terminalPreview:detach handler), and a same-frame remount costs nothing.
const pending = new Map<string, string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  flushTimer = null
  if (pending.size === 0) {
    return
  }
  const bySurface = new Map<string, string[]>()
  for (const [ptyId, surfaceId] of pending) {
    bySurface.set(surfaceId, [...(bySurface.get(surfaceId) ?? []), ptyId])
  }
  pending.clear()
  for (const [surfaceId, ptyIds] of bySurface) {
    void window.api.terminalPreview.detach(ptyIds, surfaceId).catch(() => undefined)
  }
}

/** Release this surface's stream and grid claim on the pty with the next batch. */
export function queuePreviewDetach(ptyId: string, surfaceId: string): void {
  pending.set(ptyId, surfaceId)
  if (flushTimer === null) {
    // Why a macrotask, not a microtask: a remount lands in the same React
    // commit as the unmount, and its effect must run before the batch flushes.
    flushTimer = setTimeout(flush, 0)
  }
}

/**
 * A preview for this pty mounted again before the batch went out: keep its
 * claim and hand back the surface id main still holds, so the remount carries
 * on as that surface instead of leaking it.
 */
export function cancelPreviewDetach(ptyId: string): string | null {
  const surfaceId = pending.get(ptyId) ?? null
  pending.delete(ptyId)
  return surfaceId
}
