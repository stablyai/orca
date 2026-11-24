/** One wake-driven frame burst tracks pane moves for all hosts; an idle app schedules no frames. Trust Chromium rAF throttling, not macOS’s potentially stale hidden state; isolate host errors and always settle. */

/** Re-reads one host's container rect and repositions its overlay. */
export type BrowserClientPagePositionSync = () => void

/** Frames synced per wake: wakes follow each DOM change, so a short tail sees settled layout. */
export const BROWSER_CLIENT_PAGE_POSITION_SETTLE_FRAMES = 2

/** Frameless recheck that bounds staleness when a move has no wake (style sheet edit, script animation). */
export const BROWSER_CLIENT_PAGE_POSITION_RECHECK_MS = 1_000

// Fixed-size widgets that rewrite their own DOM constantly (terminal output, editor typing) never move panes.
const SELF_CONTAINED_SELECTOR = '.xterm, .monaco-editor'

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
let settleFramesLeft = 0
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

function syncAll(): void {
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
}

function runFrame(): void {
  frame = null
  try {
    syncAll()
  } finally {
    settleFramesLeft -= 1
    if (settleFramesLeft > 0 || hasFiniteAnimationRunning()) {
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
  settleFramesLeft = BROWSER_CLIENT_PAGE_POSITION_SETTLE_FRAMES
  startFrame()
}

function isSelfContainedMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement
  return Boolean(target?.closest(SELF_CONTAINED_SELECTOR))
}

function wakeOnLayoutMutation(records: MutationRecord[]): void {
  if (!records.every(isSelfContainedMutation)) {
    wakeBrowserClientPagePositionSync()
  }
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
  const mutations =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(wakeOnLayoutMutation)
  mutations?.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  })
  const stopDevicePixelRatio = watchDevicePixelRatio()
  // Unchanged rects write nothing, so this requests no frame; a corrected host's style write wakes the burst.
  const recheck = setInterval(() => {
    if (frame === null) {
      syncAll()
    }
  }, BROWSER_CLIENT_PAGE_POSITION_RECHECK_MS)
  return () => {
    clearInterval(recheck)
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
