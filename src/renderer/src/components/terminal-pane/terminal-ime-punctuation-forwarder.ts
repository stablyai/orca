import type { IDisposable } from '@xterm/xterm'

// Why: many macOS Chinese IMEs commit full-width punctuation ("，。？！") via a
// plain `insertText` input event whose preceding keydown still reports the
// half-width ASCII symbol. With xterm's kitty keyboard protocol active, xterm
// encodes+sends that ASCII on keydown and preventDefaults it, so the input
// event carrying the real glyph is dropped and the user gets "," instead of
// "，". We bypass those keydowns so the native input pipeline runs, then forward
// the committed glyph from the input event straight to the PTY.

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

export function installTerminalImePunctuationForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
  isEnabled?: () => boolean
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

  const claimKeyEvent = (event: ImePunctuationKeyEvent): boolean => {
    if (!isImePunctuationCandidate(event, args.isComposing())) {
      return false
    }
    if (event.type === 'keydown') {
      if (args.isEnabled?.() === false) {
        return false
      }
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
      return true
    }
    if (event.type === 'keypress') {
      // Keep the keydown's armed state but still bypass xterm so it does not
      // double-send the ASCII before our input forward runs.
      return true
    }
    return false
  }

  const forwardCommittedText = (event: Event): void => {
    if (!pendingForward || !(event instanceof InputEvent)) {
      return
    }
    if (event.inputType !== 'insertText') {
      pendingForward = false
      return
    }
    pendingForward = false
    if (event.data) {
      args.sendInput(event.data)
    }
    event.stopImmediatePropagation()
    // The glyph only landed in xterm's helper textarea because we let the
    // keydown reach the native pipeline; clear it back to its empty resting
    // state so it cannot accumulate across keystrokes.
    if (event.target instanceof HTMLTextAreaElement) {
      event.target.value = ''
    }
  }

  const cancelPending = (): void => {
    pendingForward = false
    claimedPress = false
  }

  terminalElement.addEventListener('input', forwardCommittedText, true)
  terminalElement.addEventListener('blur', cancelPending, true)

  return {
    claimKeyEvent,
    dispose: () => {
      terminalElement.removeEventListener('input', forwardCommittedText, true)
      terminalElement.removeEventListener('blur', cancelPending, true)
    }
  }
}
