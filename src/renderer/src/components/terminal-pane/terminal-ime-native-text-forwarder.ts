import type { IDisposable } from '@xterm/xterm'
import {
  DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES,
  type MacNativeTextInputSourceFeatures
} from './terminal-ime-input-source'

// Why: some macOS input sources and synthetic Unicode injectors commit native
// text through a plain `insertText` event after a printable keydown. Xterm's
// kitty keyboard protocol can encode and cancel that keydown before Chromium
// commits the real text, so this narrowly bypasses known native-text candidates
// and forwards the committed glyph from the input event straight to the PTY.

export type ImeNativeTextKeyEvent = {
  type: string
  key: string
  code?: string
  keyCode?: number
  which?: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
}

type ClaimedKeyPress = {
  key: string
  code?: string
}

const CJK_DIRECT_PUNCTUATION_KEYS = new Set<string>([
  '、',
  '。',
  '，',
  '．',
  '！',
  '？',
  '；',
  '：',
  '“',
  '”',
  '‘',
  '’',
  '（',
  '）',
  '【',
  '】',
  '《',
  '》',
  '〈',
  '〉',
  '「',
  '」',
  '『',
  '』',
  '￥',
  '～',
  '·',
  '…'
])

export type TerminalImeNativeTextForwarder = IDisposable & {
  /**
   * Returns true when this keyboard event belongs to a direct native text
   * commit and should bypass xterm (the caller should return `false` from
   * `attachCustomKeyEventHandler`). The committed glyph is forwarded later from
   * the `input` event via the `sendInput` dependency.
   */
  claimKeyEvent: (event: ImeNativeTextKeyEvent) => boolean
}

function isSingleAsciiKey(key: string): number | null {
  // Reject multi-codepoint keys ("Enter", "ArrowLeft", emoji, …).
  if (Array.from(key).length !== 1) {
    return null
  }
  return key.codePointAt(0) ?? null
}

function isAsciiPunctuationKey(key: string): boolean {
  const code = isSingleAsciiKey(key)
  if (code === null) {
    return false
  }
  const isDigit = isAsciiDigitCode(code)
  const isUpperAlpha = isUpperAsciiLetterCode(code)
  const isLowerAlpha = isLowerAsciiLetterCode(code)
  // Printable ASCII excluding space (0x20), digits and letters — i.e. the
  // punctuation/symbol keys an IME may swap for a full-width or CJK glyph.
  return code > 0x20 && code <= 0x7e && !isDigit && !isUpperAlpha && !isLowerAlpha
}

function isCjkDirectPunctuationKey(key: string): boolean {
  return Array.from(key).length === 1 && CJK_DIRECT_PUNCTUATION_KEYS.has(key)
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

function isUpperAsciiLetterCode(code: number): boolean {
  return code >= 0x41 && code <= 0x5a
}

function isLowerAsciiLetterCode(code: number): boolean {
  return code >= 0x61 && code <= 0x7a
}

function isAsciiShortTextReplacementKey(key: string): boolean {
  const code = isSingleAsciiKey(key)
  if (code === null) {
    return false
  }
  return isAsciiDigitCode(code) || isUpperAsciiLetterCode(code) || isLowerAsciiLetterCode(code)
}

function isSinglePrintableTextKey(key: string): boolean {
  const chars = Array.from(key)
  if (chars.length !== 1) {
    return false
  }
  const codePoint = chars[0].codePointAt(0)
  return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f
}

function hasUnreliablePhysicalKeyIdentity(event: ImeNativeTextKeyEvent): boolean {
  const code = event.code?.trim()
  const legacyKeyCode = event.keyCode ?? event.which
  return !code || code === 'Unidentified' || legacyKeyCode === 0
}

function isSyntheticUnicodeTextKey(event: ImeNativeTextKeyEvent): boolean {
  if (!hasUnreliablePhysicalKeyIdentity(event)) {
    return false
  }
  // CGEventKeyboardSetUnicodeString-style injectors can surface as
  // `Unidentified` keydowns; the following `input` event carries the text.
  if (event.key === 'Unidentified') {
    return true
  }
  return isSinglePrintableTextKey(event.key)
}

export function isImeNativeTextKeydownCandidate(
  event: ImeNativeTextKeyEvent,
  compositionActive: boolean,
  inputSourceFeatures: MacNativeTextInputSourceFeatures = DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES
): boolean {
  if (event.type !== 'keydown') {
    return false
  }
  // Modifier chords are real shortcuts (Ctrl+C, Cmd+V, Alt+…); never a plain
  // native text commit. Shift is allowed since punctuation and uppercase
  // Vietnamese text can legitimately need it.
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false
  }
  // Composing keystrokes belong to the IME preedit and xterm's CompositionHelper
  // (which already forwards the committed text), so leave them alone.
  if (event.isComposing === true || compositionActive) {
    return false
  }
  if (isSyntheticUnicodeTextKey(event)) {
    return true
  }
  if (isCjkDirectPunctuationKey(event.key)) {
    return true
  }
  if (inputSourceFeatures.forwardAsciiPunctuation && isAsciiPunctuationKey(event.key)) {
    return true
  }
  return (
    inputSourceFeatures.forwardShortTextReplacements && isAsciiShortTextReplacementKey(event.key)
  )
}

function matchesClaimedPress(event: ImeNativeTextKeyEvent, claimedPress: ClaimedKeyPress): boolean {
  if (event.code && claimedPress.code) {
    return event.code === claimedPress.code
  }
  return event.key === claimedPress.key
}

function matchesClaimedKeypress(
  event: ImeNativeTextKeyEvent,
  claimedPress: ClaimedKeyPress
): boolean {
  if (matchesClaimedPress(event, claimedPress)) {
    return true
  }
  if (event.code && claimedPress.code) {
    return false
  }
  // Why: IME/native-text keypresses can carry the transformed glyph and omit
  // physical `code`; keep xterm silent until the input event forwards the text.
  return isSinglePrintableTextKey(event.key)
}

export function installTerminalImeNativeTextForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
  getInputSourceFeatures?: () => MacNativeTextInputSourceFeatures
}): TerminalImeNativeTextForwarder {
  if (!args.terminalElement) {
    return {
      claimKeyEvent: () => false,
      dispose: () => undefined
    }
  }

  const terminalElement = args.terminalElement
  let pendingForward = false
  let pendingForwardClearTimer: number | null = null
  let claimedPress: ClaimedKeyPress | null = null

  const clearPendingForwardTimer = (): void => {
    if (pendingForwardClearTimer !== null) {
      window.clearTimeout(pendingForwardClearTimer)
      pendingForwardClearTimer = null
    }
  }

  const disarmPendingForward = (): void => {
    clearPendingForwardTimer()
    pendingForward = false
  }

  const schedulePendingForwardClear = (): void => {
    clearPendingForwardTimer()
    // Why: some macOS IMEs deliver keyup before the final insertText event;
    // keep the native commit armed briefly, then drop genuinely stray inserts.
    pendingForwardClearTimer = window.setTimeout(() => {
      pendingForward = false
      pendingForwardClearTimer = null
    }, 100)
  }

  const claimKeyEvent = (event: ImeNativeTextKeyEvent): boolean => {
    if (event.type === 'keydown') {
      if (
        !isImeNativeTextKeydownCandidate(
          event,
          args.isComposing(),
          args.getInputSourceFeatures?.() ?? DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES
        )
      ) {
        return false
      }
      // Arm forwarding so the upcoming input event is sent to the PTY.
      clearPendingForwardTimer()
      pendingForward = true
      claimedPress = { key: event.key, code: event.code }
      return true
    }
    if (!claimedPress) {
      return false
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing === true) {
      return false
    }
    if (event.type === 'keyup') {
      if (!matchesClaimedPress(event, claimedPress)) {
        return false
      }
      claimedPress = null
      if (pendingForward) {
        schedulePendingForwardClear()
      }
      // Bypass so the kitty release sequence for the swallowed press cannot leak.
      return true
    }
    if (event.type === 'keypress') {
      // Keep the keydown's armed state but still bypass xterm so it does not
      // double-send printable text before our input forward runs.
      return matchesClaimedKeypress(event, claimedPress)
    }
    return false
  }

  const forwardCommittedText = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    if (!pendingForward) {
      return
    }
    if (event.inputType !== 'insertText') {
      disarmPendingForward()
      return
    }
    disarmPendingForward()
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
    disarmPendingForward()
    claimedPress = null
  }

  terminalElement.addEventListener('input', forwardCommittedText, true)
  terminalElement.addEventListener('blur', cancelPending, true)

  return {
    claimKeyEvent,
    dispose: () => {
      cancelPending()
      terminalElement.removeEventListener('input', forwardCommittedText, true)
      terminalElement.removeEventListener('blur', cancelPending, true)
    }
  }
}
