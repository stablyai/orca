import type { CanonicalChord, KeybindingEvent } from './keybinding-types'

const MODIFIER_ALIASES: Record<string, keyof Omit<CanonicalChord, 'key'>> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift'
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  plus: '+',
  add: '+',
  minus: '-',
  subtract: '-',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  spacebar: 'space',
  ' ': 'space'
}

const CODE_KEY_MAP: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadEnter: 'enter',
  Insert: 'insert'
}

export function parseCanonicalChord(input: string): CanonicalChord {
  const rawParts = input
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  if (rawParts.length === 0) {
    throw new Error('Chord must contain a key')
  }

  const chord: CanonicalChord = {
    key: '',
    cmd: false,
    ctrl: false,
    alt: false,
    shift: false
  }

  for (const part of rawParts) {
    const modifier = MODIFIER_ALIASES[part]
    if (modifier) {
      chord[modifier] = true
      continue
    }
    if (chord.key) {
      throw new Error(`Chord has more than one non-modifier key: ${input}`)
    }
    chord.key = normalizeKey(part)
  }

  if (!chord.key) {
    throw new Error('Chord must contain a non-modifier key')
  }

  return chord
}

export function serializeCanonicalChord(chord: CanonicalChord): string {
  const parts: string[] = []
  if (chord.cmd) {
    parts.push('cmd')
  }
  if (chord.ctrl) {
    parts.push('ctrl')
  }
  if (chord.alt) {
    parts.push('alt')
  }
  if (chord.shift) {
    parts.push('shift')
  }
  parts.push(chord.key)
  return parts.join('+')
}

export function eventToCanonicalChord(event: KeybindingEvent): CanonicalChord {
  return {
    key: normalizeEventKey(event),
    cmd: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  }
}

export function canonicalChordsEqual(left: CanonicalChord, right: CanonicalChord): boolean {
  return (
    left.key === right.key &&
    left.cmd === right.cmd &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift
  )
}

function normalizeEventKey(event: KeybindingEvent): string {
  const codeKey = event.code ? CODE_KEY_MAP[event.code] : undefined
  const key = event.key

  if (codeKey && event.code && !event.code.startsWith('Numpad')) {
    return codeKey
  }

  if (key && key.length === 1) {
    return normalizeKey(key)
  }

  if (codeKey) {
    return codeKey
  }

  if (event.code?.startsWith('Digit') && event.code.length === 6) {
    return event.code.charAt(5)
  }

  return normalizeKey(key || event.code || '')
}

function normalizeKey(key: string): string {
  const normalized = key.trim().toLowerCase()
  return KEY_ALIASES[normalized] ?? normalized
}
