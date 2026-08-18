export type TerminalLogicalInput = { kind: 'key'; name: string } | { kind: 'bytes'; data: string }

const ESC = '\x1b'
const CTRL_LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const SHIFT_BIT = 1
const ALT_BIT = 2
const CTRL_BIT = 4
const SUPER_BIT = 8
const KITTY_RELEASE = 3

const CSI_LETTER_KEYS: Readonly<Record<string, string>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift+tab'
}

const CSI_TILDE_KEYS: Readonly<Record<number, string>> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12'
}

const SS3_KEYS: Readonly<Record<string, string>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4'
}

const KITTY_FUNCTION_KEYS: Readonly<Record<number, string>> = {
  9: 'tab',
  13: 'enter',
  27: 'esc',
  32: 'space',
  127: 'backspace',
  57348: 'insert',
  57349: 'delete',
  57350: 'left',
  57351: 'right',
  57352: 'up',
  57353: 'down',
  57354: 'pageup',
  57355: 'pagedown',
  57356: 'home',
  57357: 'end',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [57364 + index, `f${index + 1}`]))
}

const KEY_TO_BYTES: Readonly<Record<string, string>> = {
  backspace: '\x7f',
  tab: '\t',
  enter: '\r',
  esc: ESC,
  space: ' ',
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  insert: `${ESC}[2~`,
  delete: `${ESC}[3~`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  'shift+tab': `${ESC}[Z`,
  'shift+enter': `${ESC}\r`,
  'ctrl+enter': `${ESC}[13;5u`,
  'ctrl+space': '\x00',
  'ctrl+\\': '\x1c',
  'ctrl+]': '\x1d',
  'ctrl+^': '\x1e',
  'ctrl+_': '\x1f',
  'alt+backspace': `${ESC}\x7f`,
  'ctrl+up': `${ESC}[1;5A`,
  'ctrl+down': `${ESC}[1;5B`,
  'ctrl+right': `${ESC}[1;5C`,
  'ctrl+left': `${ESC}[1;5D`,
  'alt+up': `${ESC}[1;3A`,
  'alt+down': `${ESC}[1;3B`,
  'alt+right': `${ESC}[1;3C`,
  'alt+left': `${ESC}[1;3D`,
  ...Object.fromEntries(
    Array.from(CTRL_LETTERS, (letter, index) => [`ctrl+${letter}`, String.fromCharCode(index + 1)])
  ),
  ...Object.fromEntries(Array.from(CTRL_LETTERS, (letter) => [`alt+${letter}`, `${ESC}${letter}`])),
  ...Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [`f${index + 1}`, `${ESC}O${'PQRS'[index]}`])
  )
}

const BYTES_TO_KEY: Readonly<Record<string, string>> = {
  '\x00': 'ctrl+space',
  '\x01': 'ctrl+a',
  '\x02': 'ctrl+b',
  '\x03': 'ctrl+c',
  '\x04': 'ctrl+d',
  '\x05': 'ctrl+e',
  '\x06': 'ctrl+f',
  '\x07': 'ctrl+g',
  '\x08': 'backspace',
  '\t': 'tab',
  '\n': 'ctrl+j',
  '\x0b': 'ctrl+k',
  '\x0c': 'ctrl+l',
  '\r': 'enter',
  '\x0e': 'ctrl+n',
  '\x0f': 'ctrl+o',
  '\x10': 'ctrl+p',
  '\x11': 'ctrl+q',
  '\x12': 'ctrl+r',
  '\x13': 'ctrl+s',
  '\x14': 'ctrl+t',
  '\x15': 'ctrl+u',
  '\x16': 'ctrl+v',
  '\x17': 'ctrl+w',
  '\x18': 'ctrl+x',
  '\x19': 'ctrl+y',
  '\x1a': 'ctrl+z',
  '\x1b': 'esc',
  '\x1c': 'ctrl+\\',
  '\x1d': 'ctrl+]',
  '\x1e': 'ctrl+^',
  '\x1f': 'ctrl+_',
  '\x7f': 'backspace'
}

const KITTY_CSI_U = new RegExp(`^${ESC}\\[(\\d+)(?:[;:](\\d+))?(?:[;:](\\d+))?u$`)
const CSI_SEQ = new RegExp(`^${ESC}\\[(?:(\\d+)?(?:;(\\d+))?)?([A-Z~])$`)
const SS3_SEQ = new RegExp(`^${ESC}O([A-Z])$`)
const ALT_CHAR = new RegExp(`^${ESC}([a-z0-9])$`)

export function bytesFromTerminalLogicalKey(name: string): string | null {
  return KEY_TO_BYTES[name] ?? null
}

export function terminalLogicalInputFromBytes(data: string): TerminalLogicalInput {
  const key = logicalKeyNameFromBytes(data)
  return key ? { kind: 'key', name: key } : { kind: 'bytes', data }
}

function herdrKey(base: string, modifier: number): string {
  const bits = Math.max(0, modifier - 1)
  const parts: string[] = []
  if ((bits & CTRL_BIT) !== 0) {
    parts.push('ctrl')
  }
  if ((bits & ALT_BIT) !== 0) {
    parts.push('alt')
  }
  if ((bits & SHIFT_BIT) !== 0 && base !== 'shift+tab') {
    parts.push('shift')
  }
  if ((bits & SUPER_BIT) !== 0) {
    parts.push('cmd')
  }
  return parts.length > 0 ? `${parts.join('+')}+${base}` : base
}

function kittyBaseKey(code: number): string | null {
  if (KITTY_FUNCTION_KEYS[code]) {
    return KITTY_FUNCTION_KEYS[code]
  }
  if (code >= 97 && code <= 122) {
    return String.fromCharCode(code)
  }
  if (code >= 65 && code <= 90) {
    return String.fromCharCode(code + 32)
  }
  if (code === 92) {
    return '\\'
  }
  return null
}

function logicalKeyNameFromBytes(data: string): string | null {
  if (data.length === 1) {
    return BYTES_TO_KEY[data] ?? null
  }
  if (data === `${ESC}\x7f`) {
    return 'alt+backspace'
  }
  if (data === `${ESC}\r`) {
    return 'shift+enter'
  }
  const kitty = KITTY_CSI_U.exec(data)
  if (kitty) {
    const eventType = kitty[3] === undefined ? 1 : Number(kitty[3])
    if (eventType === KITTY_RELEASE) {
      return null
    }
    const base = kittyBaseKey(Number(kitty[1]))
    if (!base) {
      return null
    }
    const modifier = kitty[2] === undefined ? 1 : Number(kitty[2])
    const bits = Math.max(0, modifier - 1)
    if (base.length === 1 && bits === SHIFT_BIT && base >= 'a' && base <= 'z') {
      return null
    }
    return herdrKey(base, modifier)
  }
  const csi = CSI_SEQ.exec(data)
  if (csi) {
    const final = csi[3]
    const first = csi[1] === undefined || csi[1] === '' ? undefined : Number(csi[1])
    const modifier = csi[2] === undefined ? 1 : Number(csi[2])
    if (final === '~') {
      if (first === undefined) {
        return null
      }
      const base = CSI_TILDE_KEYS[first]
      return base ? herdrKey(base, modifier) : null
    }
    const base = CSI_LETTER_KEYS[final ?? '']
    if (!base) {
      return null
    }
    return herdrKey(
      base,
      first !== undefined && first !== 1 && csi[2] === undefined ? first : modifier
    )
  }
  const ss3 = SS3_SEQ.exec(data)
  if (ss3) {
    return SS3_KEYS[ss3[1] ?? ''] ?? null
  }
  const alt = ALT_CHAR.exec(data)
  if (alt) {
    return `alt+${alt[1]}`
  }
  return null
}
