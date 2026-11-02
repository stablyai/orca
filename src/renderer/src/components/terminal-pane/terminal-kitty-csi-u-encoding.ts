import {
  KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES,
  KITTY_REPORT_ALTERNATE_KEYS,
  KITTY_REPORT_ASSOCIATED_TEXT,
  KITTY_REPORT_EVENT_TYPES
} from '../../../../shared/terminal-kitty-keyboard-flags'

export type TerminalKittyCsiUEventType = 'press' | 'repeat' | 'release'

export type TerminalKittyCsiUEvent = {
  flags: number
  type: TerminalKittyCsiUEventType
  primaryCodePoint: number
  shiftedCodePoint?: number
  baseCodePoint?: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  capsLock?: boolean
  numLock?: boolean
  associatedText?: string
}

type TerminalOptionKeyboardEvent = {
  key: string
  code?: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
  getModifierState?: (key: string) => boolean
  capsLock?: boolean
  numLock?: boolean
}

type LayoutCharacterResolver = (code: string, shifted: boolean) => string | undefined

const PC_101_PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: ' '
}

const KITTY_NUMPAD_CODE_POINT_BY_SUFFIX: Readonly<Record<string, number>> = {
  Decimal: 57409,
  Divide: 57410,
  Multiply: 57411,
  Subtract: 57412,
  Add: 57413,
  Enter: 57414,
  Equal: 57415,
  Separator: 57416
}

const KITTY_NUMPAD_CODE_POINT_BY_KEY: Readonly<Record<string, number>> = {
  ArrowLeft: 57417,
  ArrowRight: 57418,
  ArrowUp: 57419,
  ArrowDown: 57420,
  PageUp: 57421,
  PageDown: 57422,
  Home: 57423,
  End: 57424,
  Insert: 57425,
  Delete: 57426,
  Begin: 57427,
  Clear: 57427
}

export function pc101CharacterForCode(code: string | undefined): string | undefined {
  if (!code) {
    return undefined
  }
  if (code.startsWith('Key') && code.length === 4) {
    return code.charAt(3).toLowerCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.charAt(5)
  }
  return PC_101_PUNCTUATION_BY_CODE[code]
}

export function optionKittyPrimaryCharacterFallback(
  event: Pick<TerminalOptionKeyboardEvent, 'key' | 'code'>
): string | undefined {
  return pc101CharacterForCode(event.code) === undefined ? event.key : undefined
}

export function kittyFunctionalNumpadCodePointForEvent(
  event: Pick<TerminalOptionKeyboardEvent, 'key' | 'code'>
): number | undefined {
  if (!event.code?.startsWith('Numpad')) {
    return undefined
  }
  const navigationCodePoint = KITTY_NUMPAD_CODE_POINT_BY_KEY[event.key]
  if (navigationCodePoint !== undefined) {
    return navigationCodePoint
  }
  const suffix = event.code.slice('Numpad'.length)
  if (suffix.length === 1 && suffix >= '0' && suffix <= '9') {
    return 57399 + Number(suffix)
  }
  return KITTY_NUMPAD_CODE_POINT_BY_SUFFIX[suffix]
}

function nativePrimaryCharacterFallback(
  event: Pick<TerminalOptionKeyboardEvent, 'shiftKey'>,
  capsLock: boolean,
  fallback: string | undefined
): string | undefined {
  if (!fallback) {
    return fallback
  }
  const lowercase = fallback.toLowerCase()
  const uppercase = fallback.toUpperCase()
  if ((event.shiftKey || capsLock) && lowercase !== uppercase) {
    return [...lowercase].length === 1 ? lowercase : undefined
  }
  return event.shiftKey ? undefined : fallback
}

function singleCodePoint(value: string | undefined): number | undefined {
  return value && [...value].length === 1 ? value.codePointAt(0) : undefined
}

export function resolveTerminalKittyPrimaryCodePoint(
  event: TerminalOptionKeyboardEvent,
  context: {
    layoutCharacterForCode?: LayoutCharacterResolver
    primaryCharacterFallback?: string
  }
): number | undefined {
  const capsLock = event.capsLock ?? event.getModifierState?.('CapsLock') === true
  const numpadCodePoint = kittyFunctionalNumpadCodePointForEvent(event)
  const pc101Character = pc101CharacterForCode(event.code)
  const nativeFallback = nativePrimaryCharacterFallback(
    event,
    capsLock,
    context.primaryCharacterFallback
  )
  const primaryCharacter =
    (event.code ? context.layoutCharacterForCode?.(event.code, false) : undefined) ??
    nativeFallback ??
    pc101Character ??
    context.primaryCharacterFallback
  return numpadCodePoint ?? singleCodePoint(primaryCharacter)
}

function encodeModifiers(event: TerminalKittyCsiUEvent): number {
  let modifiers = 1
  if (event.shiftKey) {
    modifiers += 1
  }
  if (event.altKey) {
    modifiers += 2
  }
  if (event.ctrlKey) {
    modifiers += 4
  }
  if (event.metaKey) {
    modifiers += 8
  }
  if (event.capsLock) {
    modifiers += 64
  }
  if (event.numLock) {
    modifiers += 128
  }
  return modifiers
}

function associatedTextCodePoints(event: TerminalKittyCsiUEvent): string | undefined {
  if (
    event.type === 'release' ||
    event.ctrlKey ||
    (event.flags & KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES) === 0 ||
    (event.flags & KITTY_REPORT_ASSOCIATED_TEXT) === 0 ||
    !event.associatedText
  ) {
    return undefined
  }
  const codePoints = [...event.associatedText]
    .map((character) => character.codePointAt(0) as number)
    .filter((codePoint) => codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f))
  return codePoints.length > 0 ? codePoints.join(':') : undefined
}

export function encodeTerminalKittyCsiU(event: TerminalKittyCsiUEvent): string | null {
  const reportsEventTypes = (event.flags & KITTY_REPORT_EVENT_TYPES) !== 0
  if (event.type === 'release' && !reportsEventTypes) {
    return null
  }

  const keyCodes = [String(event.primaryCodePoint)]
  if ((event.flags & KITTY_REPORT_ALTERNATE_KEYS) !== 0) {
    const shifted =
      event.shiftedCodePoint === event.primaryCodePoint ? undefined : event.shiftedCodePoint
    const base = event.baseCodePoint === event.primaryCodePoint ? undefined : event.baseCodePoint
    if (shifted !== undefined || base !== undefined) {
      keyCodes.push(shifted === undefined ? '' : String(shifted))
    }
    if (base !== undefined) {
      keyCodes.push(String(base))
    }
  }

  const eventType =
    reportsEventTypes && event.type !== 'press' ? (event.type === 'repeat' ? 2 : 3) : undefined
  const textCodePoints = associatedTextCodePoints(event)
  const modifiers = encodeModifiers(event)
  let sequence = `\x1b[${keyCodes.join(':')}`
  if (modifiers > 1 || eventType !== undefined || textCodePoints !== undefined) {
    const encodedModifiers = modifiers > 1 ? String(modifiers) : eventType !== undefined ? '1' : ''
    sequence += `;${encodedModifiers}`
    if (eventType !== undefined) {
      sequence += `:${eventType}`
    }
  }
  if (textCodePoints !== undefined) {
    sequence += `;${textCodePoints}`
  }
  return `${sequence}u`
}

export function encodeTerminalOptionKittyEvent(
  event: TerminalOptionKeyboardEvent,
  context: {
    flags: number
    type: TerminalKittyCsiUEventType
    layoutCharacterForCode?: LayoutCharacterResolver
    associatedText?: string
    primaryCharacterFallback?: string
    primaryCodePoint?: number
  }
): string | null {
  const capsLock = event.capsLock ?? event.getModifierState?.('CapsLock') === true
  const numLock = event.numLock ?? event.getModifierState?.('NumLock') === true
  const numpadCodePoint = kittyFunctionalNumpadCodePointForEvent(event)
  const pc101Character = pc101CharacterForCode(event.code)
  const primaryCodePoint =
    context.primaryCodePoint ?? resolveTerminalKittyPrimaryCodePoint(event, context)
  if (primaryCodePoint === undefined) {
    return null
  }
  const shiftedCharacter =
    numpadCodePoint === undefined && event.shiftKey && event.code
      ? (context.layoutCharacterForCode?.(event.code, true) ??
        (!event.altKey ? event.key : undefined))
      : undefined
  return encodeTerminalKittyCsiU({
    flags: context.flags,
    type: context.type,
    primaryCodePoint,
    shiftedCodePoint: singleCodePoint(shiftedCharacter),
    baseCodePoint: numpadCodePoint === undefined ? singleCodePoint(pc101Character) : undefined,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    capsLock,
    numLock,
    associatedText: numpadCodePoint === undefined ? context.associatedText : undefined
  })
}
