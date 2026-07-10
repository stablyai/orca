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
  shift?: boolean
}

export const SERVE_SIM_KEYBOARD_MESSAGE_TAG = 0x06

const SHIFT_USAGE = 225
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
  const frames = buildUsageFrames(key.usage)
  return key.shift || modifiers.shift
    ? [{ type: 'down', usage: SHIFT_USAGE }, ...frames, { type: 'up', usage: SHIFT_USAGE }]
    : frames
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

export function buildServeSimKeyboardFramesForText(text: string): ServeSimKeyboardFrame[] | null {
  const frames: ServeSimKeyboardFrame[] = []
  for (const char of text) {
    if (char === '\r') {
      continue
    }
    const charFrames = buildServeSimKeyboardFramesForKey(char)
    if (!charFrames) {
      return null
    }
    frames.push(...charFrames)
  }
  return frames
}

export function encodeServeSimKeyboardFrame(key: ServeSimKeyboardFrame): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(key))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = SERVE_SIM_KEYBOARD_MESSAGE_TAG
  frame.set(json, 1)
  return frame
}
