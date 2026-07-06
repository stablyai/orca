import {
  DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES,
  type MacNativeTextInputSourceFeatures
} from './terminal-ime-input-source'

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

function isSingleAsciiKey(key: string): number | null {
  // Reject multi-codepoint keys ("Enter", "ArrowLeft", emoji, ...).
  if (Array.from(key).length !== 1) {
    return null
  }
  return key.codePointAt(0) ?? null
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

function isAsciiPunctuationKey(key: string): boolean {
  const code = isSingleAsciiKey(key)
  if (code === null) {
    return false
  }
  const isDigit = isAsciiDigitCode(code)
  const isUpperAlpha = isUpperAsciiLetterCode(code)
  const isLowerAlpha = isLowerAsciiLetterCode(code)
  // Printable ASCII excluding space (0x20), digits and letters: the keys an
  // IME may swap for a full-width or CJK glyph.
  return code > 0x20 && code <= 0x7e && !isDigit && !isUpperAlpha && !isLowerAlpha
}

function isCjkDirectPunctuationKey(key: string): boolean {
  return Array.from(key).length === 1 && CJK_DIRECT_PUNCTUATION_KEYS.has(key)
}

function isAsciiShortTextReplacementKey(key: string): boolean {
  const code = isSingleAsciiKey(key)
  if (code === null) {
    return false
  }
  return isAsciiDigitCode(code) || isUpperAsciiLetterCode(code) || isLowerAsciiLetterCode(code)
}

export function isSinglePrintableTextKey(key: string): boolean {
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
  // Modifier chords are real shortcuts (Ctrl+C, Cmd+V, Alt+...); never a plain
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
