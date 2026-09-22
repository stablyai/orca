/** One rAF loop for every shown client-hosted page overlay.
 *
 * Each overlay has to re-read its container's rect every frame, because a pane can MOVE
 * without resizing or scrolling and nothing fires an event for that. Per-host loops made
 * that cost linear in shown hosts (N loops × N forced layouts per frame); one driver
 * syncing N registered hosts keeps the loop count at one.
 *
 * Deliberately NOT gated on document visibility. Measured on Electron 43 / macOS: when the
 * window is hidden, minimized or fully occluded, `visibilityState` is 'hidden' AND Chromium
 * already runs 0 rAF callbacks/s, so a gate saves nothing it does not already save. Its only
 * effect would be in the state where `visibilityState` is wedged at 'hidden' while frames
 * still flow — Chromium's macOS occlusion tracker does that after display sleep and never
 * fires another `visibilitychange` (see `terminal-pane/stale-document-visibility.ts`) — and
 * there a gate would freeze every overlay on a window the user is looking at, with no
 * recovery. Zero upside, unrecoverable downside: let Chromium's own throttling do it.
 *
 * Sharing one loop would otherwise make a throwing host everyone's problem, so each sync is
 * isolated and the reschedule is unconditional: one bad host is skipped, never one that
 * wedges every other overlay at a stale rect with no event left to recover it.
 */

/** Re-reads one host's container rect and repositions its overlay. */
export type BrowserClientPagePositionSync = () => void

const syncs = new Set<BrowserClientPagePositionSync>()
/** Already-reported syncs, so a host failing every frame is one log line, not sixty a second. */
const reportedFailures = new WeakSet<BrowserClientPagePositionSync>()
let frame: number | null = null

function runFrame(): void {
  frame = null
  try {
    // Copied: a host may register or drop out while being synced.
    for (const sync of Array.from(syncs)) {
      try {
        sync()
      } catch (error) {
        if (!reportedFailures.has(sync)) {
          reportedFailures.add(sync)
          console.warn('[browser-pane] client-hosted page position sync failed:', error)
        }
      }
    }
  } finally {
    startFrame()
  }
}

function startFrame(): void {
  if (frame !== null || syncs.size === 0 || typeof requestAnimationFrame !== 'function') {
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

/** Registers a host with the shared loop; the returned release unregisters it. */
export function registerBrowserClientPagePositionSync(
  sync: BrowserClientPagePositionSync
): () => void {
  syncs.add(sync)
  startFrame()
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    syncs.delete(sync)
    if (syncs.size === 0) {
      stopFrame()
    }
  }
}
