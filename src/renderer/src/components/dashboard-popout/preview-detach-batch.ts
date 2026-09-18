// Coalesces preview detaches into one IPC per surface per frame: every
// hand-back main processes re-arms its global resize-suppression window (see
// the terminalPreview:detach handler), and a same-frame remount costs nothing.
const pending = new Map<string, Set<string>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  flushTimer = null
  if (pending.size === 0) {
    return
  }
  const bySurface = new Map<string, string[]>()
  for (const [ptyId, surfaceIds] of pending) {
    for (const surfaceId of surfaceIds) {
      const ptyIds = bySurface.get(surfaceId) ?? []
      ptyIds.push(ptyId)
      bySurface.set(surfaceId, ptyIds)
    }
  }
  pending.clear()
  for (const [surfaceId, ptyIds] of bySurface) {
    void window.api.terminalPreview.detach(ptyIds, surfaceId).catch(() => undefined)
  }
}

/** Release this surface's stream and grid claim on the pty with the next batch. */
export function queuePreviewDetach(ptyId: string, surfaceId: string): void {
  const surfaceIds = pending.get(ptyId) ?? new Set<string>()
  surfaceIds.add(surfaceId)
  pending.set(ptyId, surfaceIds)
  if (flushTimer === null) {
    // Why a macrotask, not a microtask: a remount lands in the same React
    // commit as the unmount, and its effect must run before the batch flushes.
    flushTimer = setTimeout(flush, 0)
  }
}

/**
 * A remount adopts one pending surface and its claim; sibling surfaces still detach.
 */
export function cancelPreviewDetach(ptyId: string): string | null {
  const surfaceIds = pending.get(ptyId)
  const surfaceId = surfaceIds?.values().next().value ?? null
  if (surfaceId !== null) {
    surfaceIds?.delete(surfaceId)
    if (surfaceIds?.size === 0) {
      pending.delete(ptyId)
    }
  }
  return surfaceId
}
