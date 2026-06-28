import type { IDisposable } from '@xterm/xterm'

// Why: with xterm's kitty keyboard protocol active, xterm encodes+sends a
// printable key on keydown and preventDefaults it, which cancels Chromium's
// native `insertText` on the helper textarea. That breaks two related cases on
// macOS:
//   1. CJK IMEs that commit full-width punctuation ("，。？！") via a plain
//      `insertText` whose preceding keydown still reports the half-width ASCII
//      symbol — the user gets "," instead of "，". We bypass those punctuation
//      keydowns (claimKeyEvent) so the native input pipeline runs, then forward
//      the committed glyph from the input event straight to the PTY.
//   2. OS-level text injection (dictation, text expanders, accessibility,
//      CGEvent keyboardSetUnicodeString) that arrives as non-composing
//      `insertText` without an immediate printable keyboard text path. xterm's
//      preventDefault-on-keydown would otherwise drop it silently. We forward
//      that injected text from the input event too.
// In both cases we stopImmediatePropagation so xterm's own `_inputEvent`
// handler cannot also forward the same glyph (it sits on the textarea, a
// descendant, so our capture-phase listener on the terminal element runs
// first).

export type ImePunctuationKeyEvent = {
  type: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
}

export type TerminalImePunctuationForwarder = IDisposable & {
  /**
   * Returns true when this keyboard event belongs to a direct IME punctuation
   * commit and should bypass xterm (the caller should return `false` from
   * `attachCustomKeyEventHandler`). The committed glyph is forwarded later from
   * the `input` event via the `sendInput` dependency.
   */
  claimKeyEvent: (event: ImePunctuationKeyEvent) => boolean
}

function isAsciiPunctuationKey(key: string): boolean {
  // Reject multi-codepoint keys ("Enter", "ArrowLeft", emoji, …).
  if (Array.from(key).length !== 1) {
    return false
  }
  const code = key.codePointAt(0)
  if (code === undefined) {
    return false
  }
  const isDigit = code >= 0x30 && code <= 0x39
  const isUpperAlpha = code >= 0x41 && code <= 0x5a
  const isLowerAlpha = code >= 0x61 && code <= 0x7a
  // Printable ASCII excluding space (0x20), digits and letters — i.e. the
  // punctuation/symbol keys an IME may swap for a full-width or CJK glyph.
  return code > 0x20 && code <= 0x7e && !isDigit && !isUpperAlpha && !isLowerAlpha
}

export function isImePunctuationCandidate(
  event: ImePunctuationKeyEvent,
  compositionActive: boolean
): boolean {
  // keypress is bypassed too: once we let the keydown reach the native pipeline
  // (no preventDefault), the browser still fires keypress, and xterm's keypress
  // handler would send the half-width ASCII a second time alongside our input
  // forward.
  if (event.type !== 'keydown' && event.type !== 'keyup' && event.type !== 'keypress') {
    return false
  }
  // Modifier chords are real shortcuts (Ctrl+C, Cmd+V, Alt+…); never a plain
  // punctuation commit. Shift is allowed since "?" / "!" / ":" need it.
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false
  }
  // Composing keystrokes belong to the IME preedit and xterm's CompositionHelper
  // (which already forwards the committed text), so leave them alone.
  if (event.isComposing === true || compositionActive) {
    return false
  }
  return isAsciiPunctuationKey(event.key)
}

function textFromKeyboardEvent(event: ImePunctuationKeyEvent): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing === true) {
    return null
  }
  return Array.from(event.key).length === 1 ? event.key : null
}

export function installTerminalImePunctuationForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
}): TerminalImePunctuationForwarder {
  if (!args.terminalElement) {
    return {
      claimKeyEvent: () => false,
      dispose: () => undefined
    }
  }

  const terminalElement = args.terminalElement
  let pendingForward = false
  let claimedPress = false
  // Why: normal typing can still emit an immediate textarea `insertText`; that
  // must not be re-forwarded after xterm already handled the keydown. Track the
  // actual printable key briefly instead of treating every key event as ownership
  // so arrows/placeholders/stale keydowns do not suppress later OS injection.
  let keyboardTextSinceInput: string | null = null
  let keypressSinceInput = false
  let keyboardAttributionTimer: number | null = null
  let suppressNextClaimedInsert = false
  let suppressClaimedInsertTimer: number | null = null
  // Why: a composition emits `insertCompositionText` (preedit) and resolves with
  // a final `insertText` whose committed text belongs to the IME, not injection.
  // Mark composition so that resolving commit is not mistaken for injected text.
  let compositionInProgress = false

  const clearKeyboardAttribution = (): void => {
    keyboardTextSinceInput = null
    keypressSinceInput = false
    if (keyboardAttributionTimer !== null) {
      window.clearTimeout(keyboardAttributionTimer)
      keyboardAttributionTimer = null
    }
  }

  const scheduleKeyboardAttributionClear = (): void => {
    if (keyboardAttributionTimer !== null) {
      window.clearTimeout(keyboardAttributionTimer)
    }
    keyboardAttributionTimer = window.setTimeout(() => {
      keyboardAttributionTimer = null
      keyboardTextSinceInput = null
      keypressSinceInput = false
    }, 0)
  }

  const clearClaimedInsertSuppression = (): void => {
    suppressNextClaimedInsert = false
    if (suppressClaimedInsertTimer !== null) {
      window.clearTimeout(suppressClaimedInsertTimer)
      suppressClaimedInsertTimer = null
    }
  }

  const scheduleClaimedInsertSuppressionClear = (): void => {
    if (suppressClaimedInsertTimer !== null) {
      window.clearTimeout(suppressClaimedInsertTimer)
    }
    suppressClaimedInsertTimer = window.setTimeout(() => {
      suppressClaimedInsertTimer = null
      suppressNextClaimedInsert = false
    }, 0)
  }

  const recordKeyboardAttribution = (event: ImePunctuationKeyEvent): void => {
    if (event.type !== 'keydown' && event.type !== 'keypress') {
      return
    }
    const keyboardText = textFromKeyboardEvent(event)
    if (keyboardText === null) {
      clearKeyboardAttribution()
      return
    }
    keyboardTextSinceInput = keyboardText
    keypressSinceInput = event.type === 'keypress'
    scheduleKeyboardAttributionClear()
  }

  const claimKeyEvent = (event: ImePunctuationKeyEvent): boolean => {
    recordKeyboardAttribution(event)
    if (!isImePunctuationCandidate(event, args.isComposing())) {
      return false
    }
    if (event.type === 'keydown') {
      // Arm forwarding so the upcoming input event is sent to the PTY.
      pendingForward = true
      claimedPress = true
      return true
    }
    if (!claimedPress) {
      return false
    }
    if (event.type === 'keyup') {
      claimedPress = false
      // The press has fully resolved; disarm so a later stray insert is ignored.
      // Also bypass so the kitty release sequence for the swallowed press cannot
      // leak.
      pendingForward = false
      clearKeyboardAttribution()
      // The claimed press ended without an input commit. Ignore only an
      // immediate trailing insert; a later standalone injection should recover.
      suppressNextClaimedInsert = true
      scheduleClaimedInsertSuppressionClear()
      return true
    }
    if (event.type === 'keypress') {
      // Keep the keydown's armed state but still bypass xterm so it does not
      // double-send the ASCII before our input forward runs.
      return true
    }
    return false
  }

  const sendAndResetTextarea = (event: InputEvent): void => {
    if (event.data) {
      args.sendInput(event.data)
    }
    event.stopImmediatePropagation()
    // The glyph only landed in xterm's helper textarea because we let the
    // native input pipeline run; clear it back to its empty resting state so it
    // cannot accumulate across keystrokes.
    if (event.target instanceof HTMLTextAreaElement) {
      event.target.value = ''
    }
  }

  const forwardCommittedText = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    const keyboardText = keyboardTextSinceInput
    const sawKeypress = keypressSinceInput
    const suppressedClaimInsert = suppressNextClaimedInsert
    clearKeyboardAttribution()
    clearClaimedInsertSuppression()
    const wasComposing = compositionInProgress
    // Composition inserts belong to xterm's CompositionHelper / the IME preedit;
    // leave them alone in every path.
    if (event.inputType === 'insertCompositionText') {
      pendingForward = false
      compositionInProgress = true
      return
    }
    // The composition resolved with this commit; clear the marker so the next
    // press starts fresh.
    compositionInProgress = false
    if (pendingForward) {
      pendingForward = false
      if (event.inputType !== 'insertText') {
        return
      }
      sendAndResetTextarea(event)
      return
    }
    // Injected text (dictation, text expanders, accessibility, CGEvent
    // keyboardSetUnicodeString) arrives as non-composing `insertText` that does
    // not belong to the immediate printable keyboard path. With kitty mode active
    // xterm would drop it on keydown preventDefault, so forward it here. Skip it
    // when xterm (or our claimed punctuation press, still open until keyup)
    // already owns this `insertText` to avoid a double-send.
    if (
      sawKeypress ||
      keyboardText !== null ||
      suppressedClaimInsert ||
      claimedPress ||
      wasComposing ||
      event.inputType !== 'insertText'
    ) {
      return
    }
    if (args.isComposing()) {
      return
    }
    sendAndResetTextarea(event)
  }

  const cancelPending = (): void => {
    pendingForward = false
    claimedPress = false
    clearKeyboardAttribution()
    clearClaimedInsertSuppression()
    compositionInProgress = false
  }

  terminalElement.addEventListener('input', forwardCommittedText, true)
  terminalElement.addEventListener('blur', cancelPending, true)

  return {
    claimKeyEvent,
    dispose: () => {
      clearKeyboardAttribution()
      clearClaimedInsertSuppression()
      terminalElement.removeEventListener('input', forwardCommittedText, true)
      terminalElement.removeEventListener('blur', cancelPending, true)
    }
  }
}
