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

/** When user input stops holding atlas rebuilds. */
export function terminalWebglAtlasInteractionEndsAt(): number {
  return lastInteractionAt + INTERACTION_QUIET_MS
}

/** How long a rebuild's remaining per-frame steps must still wait for user input to stop (0 when clear). */
export function terminalWebglAtlasInteractionHoldMs(): number {
  return Math.max(0, terminalWebglAtlasInteractionEndsAt() - performance.now())
}

// Clicks, wheel scrolls, keys and focus changes anywhere in the window (tab switches, scrolling, the chat composer, coming back to the window) count as input too, and so do clicks into an embedded browser page, which main reports, and the window being shown again.
if (
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0) &&
  typeof window !== 'undefined' &&
  window.addEventListener
) {
  for (const type of ['pointerdown', 'wheel', 'keydown', 'focus'] as const) {
    window.addEventListener(type, noteTerminalWebglAtlasTyping, { capture: true, passive: true })
  }
  // A held pointer (text selection, divider drag) keeps counting while it moves.
  window.addEventListener(
    'pointermove',
    (event) => {
      if (event.buttons !== 0) {
        noteTerminalWebglAtlasTyping()
      }
    },
    { capture: true, passive: true }
  )
  window.api?.ui?.onBrowserPagePointerDown?.(noteTerminalWebglAtlasTyping)
  subscribeWindowParkVisibility(noteTerminalWebglAtlasTyping)
}

// Rebuilds run only while the window is shown and the host page has focus: keys and wheel inside an embedded browser page (a <webview>) or another app never reach this document, so focus there counts as the user being busy.
const unparkCallbacks = new Set<() => void>()
let stopWatchingWindow: (() => void) | null = null

function focusIsInEmbeddedPage(): boolean {
  const tag = document.activeElement?.tagName
  return tag === 'WEBVIEW' || tag === 'IFRAME'
}

/** True while the window is hidden, another app has focus, or focus is inside an embedded browser page. */
export function isTerminalWebglAtlasRebuildParked(): boolean {
  if (!getWindowParkVisible()) {
    return true
  }
  if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') {
    return false
  }
  return !document.hasFocus() || focusIsInEmbeddedPage()
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
    const callbacks = [...unparkCallbacks]
    unparkCallbacks.clear()
    for (const resume of callbacks) {
      resume()
    }
  }
  const stopVisibility = subscribeWindowParkVisibility(check)
  const canListenToFocus =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  // focusin: focus leaving a browser page for the host page fires no window focus event.
  if (canListenToFocus) {
    window.addEventListener('focus', check)
    window.addEventListener('focusin', check, true)
  }
  stopWatchingWindow = () => {
    stopVisibility()
    if (canListenToFocus) {
      window.removeEventListener('focus', check)
      window.removeEventListener('focusin', check, true)
    }
  }
}

/** True while a parked rebuild is waiting for the window, so output can't restart its timer. */
export function rebuildingTerminalWebglAtlasParkWatch(): boolean {
  return stopWatchingWindow !== null
}
