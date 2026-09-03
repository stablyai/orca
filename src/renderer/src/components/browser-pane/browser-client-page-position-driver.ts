/** One rAF loop for every shown client-hosted page overlay.
 *
 * Each overlay has to re-read its container's rect every frame, because a pane can MOVE
 * without resizing or scrolling and nothing fires an event for that. Per-host loops made
 * that cost linear in shown hosts (N loops × N forced layouts per frame); one driver
 * syncing N registered hosts keeps the loop count at one.
 *
 * The loop is gated on document visibility: a hidden document paints nothing, so no
 * overlay can be observed at a stale rect, and every host is resynced the instant the
 * document becomes visible again — before the loop resumes.
 */

/** Re-reads one host's container rect and repositions its overlay. */
export type BrowserClientPagePositionSync = () => void

const syncs = new Set<BrowserClientPagePositionSync>()
let frame: number | null = null
let listeningToVisibility = false

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function syncRegisteredHosts(): void {
  // Copied: a host may register or drop out while being synced.
  for (const sync of Array.from(syncs)) {
    sync()
  }
}

function runFrame(): void {
  frame = null
  syncRegisteredHosts()
  startFrame()
}

function startFrame(): void {
  if (
    frame !== null ||
    syncs.size === 0 ||
    !isDocumentVisible() ||
    typeof requestAnimationFrame !== 'function'
  ) {
    return
  }
  frame = requestAnimationFrame(runFrame)
}

function stopFrame(): void {
  if (frame === null) {
    return
  }
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frame)
  }
  frame = null
}

function handleVisibilityChange(): void {
  if (!isDocumentVisible()) {
    stopFrame()
    return
  }
  // Resync before resuming so the first observable frame already has the current rects.
  syncRegisteredHosts()
  startFrame()
}

/** Registers a host with the shared loop; the returned release unregisters it. */
export function registerBrowserClientPagePositionSync(
  sync: BrowserClientPagePositionSync
): () => void {
  syncs.add(sync)
  if (!listeningToVisibility && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    listeningToVisibility = true
  }
  startFrame()
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    syncs.delete(sync)
    if (syncs.size > 0) {
      return
    }
    stopFrame()
    if (listeningToVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      listeningToVisibility = false
    }
  }
}
