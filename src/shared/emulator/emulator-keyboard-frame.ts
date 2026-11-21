export type ServeSimKeyboardType = 'down' | 'up'

export type ServeSimKeyboardFrame = {
  type: ServeSimKeyboardType
  usage: number
}

type KeyUsage = {
  shift: boolean
  usage: number
}

type ServeSimKeyboardModifiers = {
  alt?: boolean
  meta?: boolean
  shift?: boolean
}

export const SERVE_SIM_KEYBOARD_MESSAGE_TAG = 0x06

const SHIFT_USAGE = 225
const ALT_USAGE = 226
const META_USAGE = 227
const ASCII_KEY_USAGES: Record<string, KeyUsage> = buildAsciiKeyUsages()

const NAMED_KEY_USAGES: Record<string, number> = {
  Backspace: 42,
  Delete: 76,
  End: 77,
  Escape: 41,
  Home: 74,
  PageDown: 78,
  PageUp: 75,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82
}

// KeyboardEvent.code names a physical key; the guest's hardware layout decides its character.
const PHYSICAL_KEY_USAGES: ReadonlyMap<string, number> = buildPhysicalKeyUsages()

function buildPhysicalKeyUsages(): Map<string, number> {
  const usages: Record<string, number> = {
    ...NAMED_KEY_USAGES,
    Enter: 40,
    Tab: 43,
    Space: 44,
    Minus: 45,
    Equal: 46,
    BracketLeft: 47,
    BracketRight: 48,
    Backslash: 49,
    Semicolon: 51,
    Quote: 52,
    Backquote: 53,
    Comma: 54,
    Period: 55,
    Slash: 56,
    NumpadDivide: 84,
    NumpadMultiply: 85,
    NumpadSubtract: 86,
    NumpadAdd: 87,
    NumpadEnter: 88,
    Numpad0: 98,
    NumpadDecimal: 99,
    IntlBackslash: 100,
    NumpadEqual: 103,
    IntlRo: 135,
    IntlYen: 137
  }
  for (let index = 0; index < 26; index += 1) {
    usages[`Key${String.fromCharCode(65 + index)}`] = 4 + index
  }
  for (let digit = 1; digit <= 9; digit += 1) {
    usages[`Digit${digit}`] = 29 + digit
    usages[`Numpad${digit}`] = 88 + digit
  }
  usages.Digit0 = 39
  return new Map(Object.entries(usages))
}

function buildAsciiKeyUsages(): Record<string, KeyUsage> {
  const usages: Record<string, KeyUsage> = {}
  for (let index = 0; index < 26; index += 1) {
    const usage = 4 + index
    usages[String.fromCharCode(97 + index)] = { usage, shift: false }
    usages[String.fromCharCode(65 + index)] = { usage, shift: true }
  }

  const digits = '1234567890'
  const shiftedDigits = '!@#$%^&*()'
  for (let index = 0; index < digits.length; index += 1) {
    const usage = 30 + index
    usages[digits[index]] = { usage, shift: false }
    usages[shiftedDigits[index]] = { usage, shift: true }
  }

  const punctuation: [string, string, number][] = [
    ['-', '_', 45],
    ['=', '+', 46],
    ['[', '{', 47],
    [']', '}', 48],
    ['\\', '|', 49],
    [';', ':', 51],
    ["'", '"', 52],
    ['`', '~', 53],
    [',', '<', 54],
    ['.', '>', 55],
    ['/', '?', 56]
  ]
  for (const [plain, shifted, usage] of punctuation) {
    usages[plain] = { usage, shift: false }
    usages[shifted] = { usage, shift: true }
  }

  usages[' '] = { usage: 44, shift: false }
  usages['\n'] = { usage: 40, shift: false }
  usages['\t'] = { usage: 43, shift: false }
  return usages
}

function buildUsageFrames(usage: number): ServeSimKeyboardFrame[] {
  return [
    { type: 'down', usage },
    { type: 'up', usage }
  ]
}

function buildKeyUsageFrames(
  key: KeyUsage,
  modifiers: ServeSimKeyboardModifiers = {}
): ServeSimKeyboardFrame[] {
  let frames = buildUsageFrames(key.usage)
  const held = [
    modifiers.meta && META_USAGE,
    modifiers.alt && ALT_USAGE,
    (key.shift || modifiers.shift) && SHIFT_USAGE
  ]
  for (const usage of held) {
    if (usage) {
      frames = [{ type: 'down', usage }, ...frames, { type: 'up', usage }]
    }
  }
  return frames
}

export function buildServeSimKeyboardFramesForCode(
  code: string,
  modifiers: ServeSimKeyboardModifiers = {}
): ServeSimKeyboardFrame[] | null {
  const usage = PHYSICAL_KEY_USAGES.get(code)
  return usage === undefined ? null : buildKeyUsageFrames({ shift: false, usage }, modifiers)
}

export function buildServeSimKeyboardFramesForKey(
  key: string,
  modifiers: ServeSimKeyboardModifiers = {}
): ServeSimKeyboardFrame[] | null {
  const textKey = key === 'Enter' ? '\n' : key === 'Tab' ? '\t' : key
  const asciiUsage = ASCII_KEY_USAGES[textKey]
  if (asciiUsage) {
    return buildKeyUsageFrames(asciiUsage, modifiers)
  }
  const namedUsage = NAMED_KEY_USAGES[key]
  return namedUsage === undefined
    ? null
    : buildKeyUsageFrames({ shift: false, usage: namedUsage }, modifiers)
}

/** Whether every character has a US keyboard key, so typing it as key events loses nothing. */
export function isUSKeyboardText(text: string): boolean {
  for (const char of text) {
    if (char !== '\r' && !Object.hasOwn(ASCII_KEY_USAGES, char)) {
      return false
    }
  }
  return true
}

export function encodeServeSimKeyboardFrame(key: ServeSimKeyboardFrame): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(key))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = SERVE_SIM_KEYBOARD_MESSAGE_TAG
  frame.set(json, 1)
  return frame
}
