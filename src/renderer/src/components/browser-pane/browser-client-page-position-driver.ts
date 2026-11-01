/** One wake-driven frame burst tracks pane moves for all hosts; an idle app schedules no frames. Trust Chromium rAF throttling, not macOS’s potentially stale hidden state; isolate host errors and always settle. */

/** Re-reads one host's container rect and repositions its overlay. */
export type BrowserClientPagePositionSync = () => void

/** Frames keep running this long after the last wake, so layout settling after a commit is seen. */
export const BROWSER_CLIENT_PAGE_POSITION_SETTLE_MS = 250

// Pane moves and overlays need a DOM, style, viewport or input change; each of these can start one.
const WINDOW_WAKE_EVENTS = [
  'resize',
  'scroll',
  'transitionrun',
  'transitionend',
  'transitioncancel',
  'animationstart',
  'animationend',
  'animationcancel',
  'pointerdown',
  'pointerup',
  'pointerover',
  'pointerout',
  'keydown',
  'keyup',
  'focusin',
  'focusout',
  'dragenter',
  'dragleave',
  'dragend',
  'drop',
  'load'
] as const

const syncs = new Set<BrowserClientPagePositionSync>()
/** Already-reported syncs, so a host failing every frame is one log line, not sixty a second. */
const reportedFailures = new WeakSet<BrowserClientPagePositionSync>()
let frame: number | null = null
let settleUntil = 0
let stopWakeSources: (() => void) | null = null

/** A finite transition or animation may be moving a pane without firing events per frame. */
function hasFiniteAnimationRunning(): boolean {
  if (typeof document.getAnimations !== 'function') {
    return false
  }
  return document
    .getAnimations()
    .some(
      (animation) =>
        animation.playState === 'running' &&
        animation.effect?.getComputedTiming().endTime !== Infinity
    )
}

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
    if (performance.now() < settleUntil || hasFiniteAnimationRunning()) {
      startFrame()
    }
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

function wakeBrowserClientPagePositionSync(): void {
  settleUntil = performance.now() + BROWSER_CLIENT_PAGE_POSITION_SETTLE_MS
  startFrame()
}

function watchDevicePixelRatio(): () => void {
  if (typeof matchMedia !== 'function') {
    return () => {}
  }
  let query: MediaQueryList | null = null
  const onChange = (): void => {
    query?.removeEventListener('change', onChange)
    query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', onChange)
    wakeBrowserClientPagePositionSync()
  }
  onChange()
  return () => query?.removeEventListener('change', onChange)
}

function startWakeSources(): () => void {
  const wake = wakeBrowserClientPagePositionSync
  const options = { capture: true, passive: true }
  for (const type of WINDOW_WAKE_EVENTS) {
    window.addEventListener(type, wake, options)
  }
  document.addEventListener('visibilitychange', wake)
  document.fonts?.addEventListener('loadingdone', wake)
  const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(wake)
  mutations?.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  })
  const stopDevicePixelRatio = watchDevicePixelRatio()
  return () => {
    for (const type of WINDOW_WAKE_EVENTS) {
      window.removeEventListener(type, wake, options)
    }
    document.removeEventListener('visibilitychange', wake)
    document.fonts?.removeEventListener('loadingdone', wake)
    mutations?.disconnect()
    stopDevicePixelRatio()
  }
}

/** Registers a host with the shared driver; the returned release unregisters it. */
export function registerBrowserClientPagePositionSync(
  sync: BrowserClientPagePositionSync
): () => void {
  syncs.add(sync)
  stopWakeSources ??= startWakeSources()
  wakeBrowserClientPagePositionSync()
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    syncs.delete(sync)
    if (syncs.size === 0) {
      stopFrame()
      stopWakeSources?.()
      stopWakeSources = null
    }
  }
}
