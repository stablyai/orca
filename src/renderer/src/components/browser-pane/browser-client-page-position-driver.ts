/** One loop tracks eventless pane moves for all hosts. Trust Chromium rAF throttling, not macOS’s potentially stale hidden state; isolate host errors and always reschedule. */

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
