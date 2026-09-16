import type { KeybindingInput, ModifierToken, ParsedKeybinding } from './types'

export function hasModifier(
  input: KeybindingInput,
  modifier: 'alt' | 'meta' | 'control' | 'shift'
): boolean {
  if (modifier === 'alt') {
    return Boolean(input.alt ?? input.altKey)
  }
  if (modifier === 'meta') {
    return Boolean(input.meta ?? input.metaKey)
  }
  if (modifier === 'control') {
    return Boolean(input.control ?? input.ctrlKey)
  }
  return Boolean(input.shift ?? input.shiftKey)
}

const SIMPLE_KEY_TOKENS = new Map<string, string>(
  Object.entries({
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '{': 'BracketLeft',
    '}': 'BracketRight',
    '-': 'Minus',
    _: 'Underscore',
    '=': 'Equal',
    '+': 'Plus',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    RETURN: 'Enter',
    ESC: 'Escape',
    SPACEBAR: 'Space',
    PGUP: 'PageUp',
    PGDN: 'PageDown',
    PLUS: 'Plus',
    MINUS: 'Minus',
    EQUAL: 'Equal',
    UNDERSCORE: 'Underscore',
    ARROWLEFT: 'ArrowLeft',
    LEFT: 'ArrowLeft',
    ARROWRIGHT: 'ArrowRight',
    RIGHT: 'ArrowRight',
    ARROWUP: 'ArrowUp',
    UP: 'ArrowUp',
    ARROWDOWN: 'ArrowDown',
    DOWN: 'ArrowDown',
    PAGEUP: 'PageUp',
    PAGEDOWN: 'PageDown',
    BACKSPACE: 'Backspace',
    DELETE: 'Delete',
    DEL: 'Delete',
    INSERT: 'Insert',
    INS: 'Insert',
    ENTER: 'Enter',
    TAB: 'Tab',
    ESCAPE: 'Escape',
    SPACE: 'Space',
    BRACKETLEFT: 'BracketLeft',
    BRACKETRIGHT: 'BracketRight',
    NUMPADADD: 'NumpadAdd',
    NUMPADSUBTRACT: 'NumpadSubtract',
    ADD: 'NumpadAdd',
    SUBTRACT: 'NumpadSubtract',
    COMMA: 'Comma',
    PERIOD: 'Period',
    SLASH: 'Slash',
    BACKSLASH: 'Backslash',
    SEMICOLON: 'Semicolon',
    QUOTE: 'Quote',
    BACKQUOTE: 'Backquote'
  })
)

function isFunctionKeyToken(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
}

export function normalizeKeyToken(token: string): string | null {
  if (token === ' ') {
    return 'Space'
  }
  const trimmed = token.trim()
  if (!trimmed) {
    return null
  }
  const upper = trimmed.toUpperCase()
  if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
    return upper
  }
  if (upper.length === 1 && upper >= '0' && upper <= '9') {
    return upper
  }
  // Function keys F1–F24 (event.key/event.code report them verbatim, e.g. F7).
  if (isFunctionKeyToken(upper)) {
    return upper
  }

  return SIMPLE_KEY_TOKENS.get(upper) ?? null
}

export function parseModifierToken(rawPart: string): ModifierToken | null {
  const part = rawPart.toLowerCase()
  if (part === 'mod' || part === 'cmdorctrl' || part === 'commandorcontrol') {
    return 'Mod'
  }
  if (part === 'cmd' || part === 'command' || part === 'meta' || rawPart === '⌘') {
    return 'Cmd'
  }
  if (part === 'ctrl' || part === 'control' || rawPart === '⌃') {
    return 'Ctrl'
  }
  if (part === 'alt' || part === 'option' || part === 'opt' || rawPart === '⌥') {
    return 'Alt'
  }
  if (part === 'shift' || rawPart === '⇧') {
    return 'Shift'
  }
  return null
}

export function applyModifierToken(parsed: ParsedKeybinding, modifier: ModifierToken): void {
  if (modifier === 'Mod') {
    parsed.mod = true
  } else if (modifier === 'Cmd') {
    parsed.meta = true
  } else if (modifier === 'Ctrl') {
    parsed.control = true
  } else if (modifier === 'Alt') {
    parsed.alt = true
  } else {
    parsed.shift = true
  }
}

export function emptyParsedKeybinding(): ParsedKeybinding {
  return { mod: false, meta: false, control: false, alt: false, shift: false, key: '' }
}

// Why: a double-tap is a bare modifier with no key, so it can't use the normal parse path; modifier validation is deferred to normalize.
export function parseDoubleTapKeybinding(rawParts: string[]): ParsedKeybinding | null {
  const modifiers: ModifierToken[] = []
  let sawDoubleTap = false
  for (const rawPart of rawParts) {
    if (rawPart.toLowerCase() === 'doubletap') {
      if (sawDoubleTap) {
        return null
      }
      sawDoubleTap = true
      continue
    }
    const modifier = parseModifierToken(rawPart)
    if (!modifier) {
      return null
    }
    modifiers.push(modifier)
  }
  if (modifiers.length === 0) {
    return null
  }
  const parsed = emptyParsedKeybinding()
  for (const modifier of modifiers) {
    applyModifierToken(parsed, modifier)
  }
  // Keep both flags when Mod is combined with a platform modifier, so normalize emits the shared "Mod or platform-specific, not both" error.
  if (parsed.mod && (parsed.meta || parsed.control)) {
    parsed.doubleTapModifier = 'Mod'
    return parsed
  }
  if (modifiers.length > 1) {
    return null
  }
  parsed.doubleTapModifier = modifiers[0]
  return parsed
}

// Binding strings come from a fixed definition set plus user overrides, so the live set is tiny; the cap only guards a caller feeding arbitrary strings.
const PARSE_CACHE_LIMIT = 512
const parseCache = new Map<string, ParsedKeybinding | null>()

export function parseKeybinding(binding: string): ParsedKeybinding | null {
  if (parseCache.has(binding)) {
    return parseCache.get(binding) ?? null
  }
  const parsed = parseKeybindingUncached(binding)
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.clear()
  }
  // Frozen so a caller can never corrupt the shared entry; every current caller spread-copies before changing a field.
  parseCache.set(binding, parsed ? Object.freeze(parsed) : null)
  return parsed
}

function parseKeybindingUncached(binding: string): ParsedKeybinding | null {
  const rawParts = binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (rawParts.length === 0) {
    return null
  }

  if (rawParts.some((part) => part.toLowerCase() === 'doubletap')) {
    return parseDoubleTapKeybinding(rawParts)
  }

  const parsed = emptyParsedKeybinding()
  for (const rawPart of rawParts) {
    const modifier = parseModifierToken(rawPart)
    if (modifier) {
      applyModifierToken(parsed, modifier)
      continue
    }
    if (parsed.key) {
      return null
    }
    const key = normalizeKeyToken(rawPart)
    if (!key) {
      return null
    }
    parsed.key = key
  }

  return parsed.key ? parsed : null
}

export function canonicalizeParsedKeybinding(parsed: ParsedKeybinding): string {
  if (parsed.doubleTapModifier) {
    return `DoubleTap+${parsed.doubleTapModifier}`
  }
  const parts: string[] = []
  if (parsed.mod) {
    parts.push('Mod')
  }
  if (parsed.meta) {
    parts.push('Cmd')
  }
  if (parsed.control) {
    parts.push('Ctrl')
  }
  if (parsed.alt) {
    parts.push('Alt')
  }
  if (parsed.shift) {
    parts.push('Shift')
  }
  parts.push(parsed.key)
  return parts.join('+')
}

export function isSafeBareKey(parsed: ParsedKeybinding): boolean {
  if (parsed.mod || parsed.meta || parsed.control || parsed.alt) {
    return false
  }
  // Function keys produce no text, so they're safe bare or with Shift (Shift+letter stays unsafe).
  if (parsed.shift) {
    return isFunctionKeyToken(parsed.key)
  }
  return (
    isFunctionKeyToken(parsed.key) ||
    [
      'Backspace',
      'Delete',
      'Enter',
      'Escape',
      'Tab',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown'
    ].includes(parsed.key)
  )
}
