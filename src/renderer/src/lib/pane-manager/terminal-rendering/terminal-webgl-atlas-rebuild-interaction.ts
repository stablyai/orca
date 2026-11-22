import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '../../window-activity/window-park-visibility'

// Atlas rebuilds stay out of the user's way: any input holds them this long, and they run only while the window is shown and focused.
const INTERACTION_QUIET_MS = 2_000
let lastInteractionAt = Number.NEGATIVE_INFINITY

/** User input (typing, pastes, clicks, scrolls); holds atlas rebuilds and their remaining per-frame steps. */
export function noteTerminalWebglAtlasTyping(): void {
  lastInteractionAt = performance.now()
}

/** How long a rebuild's remaining per-frame steps must still wait for user input to stop (0 when clear). */
export function terminalWebglAtlasInteractionHoldMs(): number {
  return Math.max(0, lastInteractionAt + INTERACTION_QUIET_MS - performance.now())
}

// Clicks, wheel scrolls and keys anywhere in the window (tab switches, scrolling, the chat composer) count as input too, and so do clicks into an embedded browser page, which main reports.
if (
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0) &&
  typeof window !== 'undefined' &&
  window.addEventListener
) {
  for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
    window.addEventListener(type, noteTerminalWebglAtlasTyping, { capture: true, passive: true })
  }
  window.api?.ui?.onBrowserPagePointerDown?.(noteTerminalWebglAtlasTyping)
}

// Rebuilds run only while the window is shown and has focus: input inside an embedded browser page or another app never reaches this document, so focus elsewhere counts as the user being busy.
const unparkCallbacks = new Set<() => void>()
let stopWatchingWindow: (() => void) | null = null

/** True while the window is hidden or another surface (browser page, other app) has focus. */
export function isTerminalWebglAtlasRebuildParked(): boolean {
  const focused =
    typeof document === 'undefined' ||
    typeof document.hasFocus !== 'function' ||
    document.hasFocus()
  return !getWindowParkVisible() || !focused
}

/** Runs the callback once the window is shown and focused again; one shared watcher, no polling. */
export function whenTerminalWebglAtlasRebuildUnparked(callback: () => void): void {
  unparkCallbacks.add(callback)
  if (stopWatchingWindow) {
    return
  }
  const check = (): void => {
    if (isTerminalWebglAtlasRebuildParked() || !stopWatchingWindow) {
      return
    }
    stopWatchingWindow()
    stopWatchingWindow = null
    // Coming back is itself interaction; the 2 s quiet then starts from here.
    noteTerminalWebglAtlasTyping()
    const callbacks = [...unparkCallbacks]
    unparkCallbacks.clear()
    for (const resume of callbacks) {
      resume()
    }
  }
  const stopVisibility = subscribeWindowParkVisibility(check)
  const canListenToFocus =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (canListenToFocus) {
    window.addEventListener('focus', check)
  }
  stopWatchingWindow = () => {
    stopVisibility()
    if (canListenToFocus) {
      window.removeEventListener('focus', check)
    }
  }
}

/** True while a parked rebuild is waiting for the window, so output can't restart its timer. */
export function rebuildingTerminalWebglAtlasParkWatch(): boolean {
  return stopWatchingWindow !== null
}
