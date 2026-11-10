import { webviewRegistry } from './webview-registry'

// Main brackets agent guest input; restore the user’s element afterward because guest/CDP focus would otherwise retain their keyboard.

// Why: the input's own focus move can reach this renderer just after the end message.
const LATE_FOCUS_RECHECK_MS = 50
// Why: an end message lost with a crashed main-side command must not pin the shared state.
const ABANDONED_GUARD_MS = 30_000

const releasesByToken = new Map<string, () => void>()
// Refuse agent presses during composition; blurring would commit unfinished text into the terminal shell.
let composingElement: EventTarget | null = null
// Overlapping guards share the first user element; later activeElement values may belong to agent-focused guests.
let inFlight = 0
let userElement: Element | null = null

function settle(): void {
  inFlight -= 1
  if (inFlight === 0) {
    userElement = null
  }
}

function isUserComposing(): boolean {
  return composingElement !== null && composingElement === document.activeElement
}

/** Tracks the window's open IME composition, by the terminal tracker's rules; returns the unsubscribe. */
export function watchUserComposition(): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  const onStart = (event: Event): void => {
    composingElement = event.target
  }
  // Nonempty updates can begin composition without start; Sogou/fcitx empty updates do not end an open candidate popup.
  const onUpdate = (event: Event): void => {
    if (event instanceof CompositionEvent && event.data !== '') {
      composingElement = event.target
    }
  }
  const onEnd = (): void => {
    composingElement = null
  }
  // Non-composing input clears missed endings; composition-owned Cangjie Backspace must keep the guard active.
  const onInput = (event: Event): void => {
    if (!(event instanceof InputEvent && event.isComposing)) {
      composingElement = null
    }
  }
  const listeners: [string, (event: Event) => void][] = [
    ['compositionstart', onStart],
    ['compositionupdate', onUpdate],
    ['compositionend', onEnd],
    ['input', onInput]
  ]
  for (const [type, listener] of listeners) {
    document.addEventListener(type, listener, true)
  }
  return () => {
    for (const [type, listener] of listeners) {
      document.removeEventListener(type, listener, true)
    }
    composingElement = null
  }
}

/** Refuses the input while the user composes; otherwise holds their focus until the input ends. */
export function beginAgentInputFocusGuard(
  browserPageId: string,
  token: string
): 'ready' | 'composing' {
  if (isUserComposing()) {
    return 'composing'
  }
  guardUserFocus(browserPageId, token)
  return 'ready'
}

function guardUserFocus(browserPageId: string, token: string): void {
  const webview = webviewRegistry.get(browserPageId)
  if (!webview) {
    return
  }
  if (inFlight === 0) {
    // Why: a user already typing in this page keeps it; the input lands where they are.
    if (document.activeElement === webview) {
      return
    }
    userElement = document.activeElement
  }
  inFlight += 1
  const previous = userElement
  const restore = (): void => {
    if (document.activeElement !== webview) {
      return
    }
    if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
      previous.focus({ preventScroll: true })
    } else {
      webview.blur()
    }
  }
  const abandoned = setTimeout(() => endAgentInputFocusGuard(token), ABANDONED_GUARD_MS)
  releasesByToken.set(token, () => {
    clearTimeout(abandoned)
    restore()
    setTimeout(() => {
      restore()
      settle()
    }, LATE_FOCUS_RECHECK_MS)
  })
}

export function endAgentInputFocusGuard(token: string): void {
  const release = releasesByToken.get(token)
  releasesByToken.delete(token)
  release?.()
}

export function clearAgentInputFocusGuards(): void {
  for (const release of releasesByToken.values()) {
    release()
  }
  releasesByToken.clear()
}
