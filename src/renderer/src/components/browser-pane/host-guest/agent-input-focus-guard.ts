import { webviewRegistry } from './webview-registry'

// Why: an agent press on a <webview> guest moves Chromium focus into it, and CDP-only agent input
// needs the guest focused, so either would keep the user's keyboard (#20595). Main brackets that
// input; the pane gives focus back to the user's element when it ends.
// See docs/reference/agent-browser-focus-isolation.md.

// Why: the input's own focus move can reach this renderer just after the end message.
const LATE_FOCUS_RECHECK_MS = 50
// Why: an end message lost with a crashed main-side command must not pin the shared state.
const ABANDONED_GUARD_MS = 30_000

const releasesByToken = new Map<string, () => void>()
// Why: blurring an element mid-composition commits the unfinished text, which a terminal sends to
// the shell, so agent presses are refused while the user composes (#28700).
let composingElement: EventTarget | null = null
// Why: while any agent input or its recheck is in flight, document.activeElement may be a page
// an agent focused, not the user's choice; overlapping guards share the element seen first.
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
  // Why: some IMEs send a nonempty update without a new compositionstart; Sogou/fcitx send empty
  // ones while the candidate popup is still open, so those must not end it.
  const onUpdate = (event: Event): void => {
    if (event instanceof CompositionEvent && event.data !== '') {
      composingElement = event.target
    }
  }
  const onEnd = (): void => {
    composingElement = null
  }
  // Why: typing outside a composition proves none is open, so a missed compositionend cannot stick.
  // Composition-owned input, like Cangjie's Backspace over one of several radicals, keeps it open.
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
