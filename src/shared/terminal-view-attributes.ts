/** Share pty:terminalViewAttributes and xterm XParseColor grammar so main’s hidden-PTY replies match renderer replies. */
import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'

export type TerminalViewRgb = [number, number, number]

export const TERMINAL_VIEW_ANSI_COLOR_COUNT = 256

export type TerminalViewCursorStyle = 'bar' | 'block' | 'underline'

/** One app-global appearance snapshot covers all PTYs; per-pane font zoom does not affect these attributes. */
export type TerminalViewAttributes = {
  foreground: TerminalViewRgb
  background: TerminalViewRgb
  /** xterm blends cursor alpha over background at theme-set time. */
  cursor: TerminalViewRgb
  /** Match ThemeService’s full 256-color palette, including the extended/default tail. */
  ansi: TerminalViewRgb[]
  /** App mode drives 2031 flips; ?996n instead uses terminal relative luminance, so a light app with a dark terminal can disagree. */
  colorSchemeMode: 'dark' | 'light'
  cursorStyle: TerminalViewCursorStyle
  cursorBlink: boolean
}

// Mirror of @xterm XParseColor RGB_REX: r/g/b channels in 1-4 hex digits.
const X_RGB_SPEC_RE =
  /^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/
const X_HASH_SPEC_RE = /^[\da-f]+$/

/** Match xterm OSC 4/10/11/12 SET grammar: equal 1–4-digit rgb channels or 3/6/9/12-digit hex; reject named colors and rgbi:. */
export function parseXColorSpec(spec: string): TerminalViewRgb | null {
  if (!spec) {
    return null
  }
  let low = spec.toLowerCase()
  if (low.startsWith('rgb:')) {
    low = low.slice(4)
    const m = X_RGB_SPEC_RE.exec(low)
    if (m) {
      const base = m[1] ? 15 : m[4] ? 255 : m[7] ? 4095 : 65535
      return [
        Math.round((Number.parseInt(m[1] || m[4] || m[7] || m[10], 16) / base) * 255),
        Math.round((Number.parseInt(m[2] || m[5] || m[8] || m[11], 16) / base) * 255),
        Math.round((Number.parseInt(m[3] || m[6] || m[9] || m[12], 16) / base) * 255)
      ]
    }
    return null
  }
  if (low.startsWith('#')) {
    low = low.slice(1)
    if (X_HASH_SPEC_RE.exec(low) && [3, 6, 9, 12].includes(low.length)) {
      const adv = low.length / 3
      const result: TerminalViewRgb = [0, 0, 0]
      for (let i = 0; i < 3; ++i) {
        const c = Number.parseInt(low.slice(adv * i, adv * i + adv), 16)
        result[i] = adv === 1 ? c << 4 : adv === 2 ? c : adv === 3 ? c >> 4 : c >> 8
      }
      return result
    }
  }
  return null
}

function padChannelTo16Bit(value: number): string {
  const hex = value.toString(16)
  const byte = hex.length < 2 ? `0${hex}` : hex
  // Repeat 8-bit bytes for xterm’s 16-bit reply format; do not rescale differently.
  return byte + byte
}

export function formatXColorRgbSpec(rgb: TerminalViewRgb): string {
  return `rgb:${padChannelTo16Bit(rgb[0])}/${padChannelTo16Bit(rgb[1])}/${padChannelTo16Bit(rgb[2])}`
}

// Match xterm’s relativeLuminance2 calculation for private DSR ?996n replies.
function relativeLuminance([r, g, b]: TerminalViewRgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
}

/** The ?996n reply: xterm derives it from current colour luminance, not the app’s colorSchemeMode. */
export function terminalColorSchemeReport(
  foreground: TerminalViewRgb,
  background: TerminalViewRgb
): string {
  return `\x1b[?997;${relativeLuminance(background) < relativeLuminance(foreground) ? 1 : 2}n`
}

export function terminalViewRgbToCssHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function terminalViewColorQueryReplyColors(
  attributes: Pick<TerminalViewAttributes, 'foreground' | 'background'>
): Required<TerminalOscColorQueryReplyColors> {
  return {
    foreground: terminalViewRgbToCssHex(attributes.foreground),
    background: terminalViewRgbToCssHex(attributes.background)
  }
}

function rgbEqual(a: TerminalViewRgb, b: TerminalViewRgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** Treat identical renderer re-pushes as no-ops, avoiding theme reapply on second windows/reloads/macOS reactivation. */
export function terminalViewAttributesEqual(
  a: TerminalViewAttributes,
  b: TerminalViewAttributes
): boolean {
  if (a === b) {
    return true
  }
  if (
    !rgbEqual(a.foreground, b.foreground) ||
    !rgbEqual(a.background, b.background) ||
    !rgbEqual(a.cursor, b.cursor) ||
    a.colorSchemeMode !== b.colorSchemeMode ||
    a.cursorStyle !== b.cursorStyle ||
    a.cursorBlink !== b.cursorBlink ||
    a.ansi.length !== b.ansi.length
  ) {
    return false
  }
  for (let i = 0; i < a.ansi.length; i++) {
    if (!rgbEqual(a.ansi[i], b.ansi[i])) {
      return false
    }
  }
  return true
}

function isRgbChannel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

function validateRgbTriple(value: unknown): TerminalViewRgb | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null
  }
  const [r, g, b] = value
  if (!isRgbChannel(r) || !isRgbChannel(g) || !isRgbChannel(b)) {
    return null
  }
  return [r, g, b]
}

/** Reject malformed IPC palettes: a wrong OSC color reply is worse than silence. */
export function validateTerminalViewAttributes(payload: unknown): TerminalViewAttributes | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const candidate = payload as Record<string, unknown>
  const foreground = validateRgbTriple(candidate.foreground)
  const background = validateRgbTriple(candidate.background)
  const cursor = validateRgbTriple(candidate.cursor)
  if (!foreground || !background || !cursor) {
    return null
  }
  if (!Array.isArray(candidate.ansi) || candidate.ansi.length !== TERMINAL_VIEW_ANSI_COLOR_COUNT) {
    return null
  }
  const ansi: TerminalViewRgb[] = []
  for (const entry of candidate.ansi) {
    const triple = validateRgbTriple(entry)
    if (!triple) {
      return null
    }
    ansi.push(triple)
  }
  if (candidate.colorSchemeMode !== 'dark' && candidate.colorSchemeMode !== 'light') {
    return null
  }
  if (
    candidate.cursorStyle !== 'bar' &&
    candidate.cursorStyle !== 'block' &&
    candidate.cursorStyle !== 'underline'
  ) {
    return null
  }
  if (typeof candidate.cursorBlink !== 'boolean') {
    return null
  }
  return {
    foreground,
    background,
    cursor,
    ansi,
    colorSchemeMode: candidate.colorSchemeMode,
    cursorStyle: candidate.cursorStyle,
    cursorBlink: candidate.cursorBlink
  }
}
