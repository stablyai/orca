/**
 * Phase 5 slice 2 (View-attribute bridge): payload contract for the
 * renderer→main `pty:terminalViewAttributes`
 * push, plus main/renderer mirrors of xterm's XParseColor color-spec grammar
 * so main's responder replies byte-identically to a visible renderer xterm.
 */

/** 8-bit-per-channel RGB triple — the same resolution xterm's theme service
 *  stores internally (`color.toColorRGB`). */
export type TerminalViewRgb = [number, number, number]

export const TERMINAL_VIEW_ANSI_COLOR_COUNT = 256

export type TerminalViewCursorStyle = 'bar' | 'block' | 'underline'

/** One app-global snapshot of the renderer's composed terminal appearance —
 *  per-pane font zoom never affects these, and terminalColorOverrides /
 *  cursor settings are global, so one push covers all PTYs. */
export type TerminalViewAttributes = {
  foreground: TerminalViewRgb
  background: TerminalViewRgb
  /** Already blended over the background (xterm ThemeService blends the
   *  cursor color's alpha at theme-set time, e.g. terminalCursorOpacity). */
  cursor: TerminalViewRgb
  /** Full 256-entry palette: theme's 16 named colors + extendedAnsi/default
   *  tail, exactly as the renderer ThemeService resolves them. */
  ansi: TerminalViewRgb[]
  /** Resolved APP color-scheme mode (the 2031/997 flip source). NOT the DSR
   *  ?996n answer: that is computed from background/foreground relative
   *  luminance like a visible xterm (_reportColorScheme), and the two can
   *  disagree (e.g. dark terminal theme in light app mode). */
  colorSchemeMode: 'dark' | 'light'
  cursorStyle: TerminalViewCursorStyle
  cursorBlink: boolean
}

// Mirror of @xterm XParseColor RGB_REX: r/g/b channels in 1-4 hex digits.
const X_RGB_SPEC_RE =
  /^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/
const X_HASH_SPEC_RE = /^[\da-f]+$/

/** Mirror of xterm's XParseColor `parseColor` (the grammar the renderer
 *  accepts for OSC 4/10/11/12 SET payloads): `rgb:h/h/h`..`rgb:hhhh/hhhh/hhhh`
 *  and `#RGB|#RRGGBB|#RRRGGGBBB|#RRRRGGGGBBBB`. Anything else (named colors,
 *  rgbi:) is rejected exactly like the renderer rejects it. */
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
  // Why doubled: xterm reports 16-bit channels by repeating the 8-bit byte
  // (XParseColor.toRgbString with bits=16) — pinned reply-format parity.
  return byte + byte
}

/** Mirror of xterm's `toRgbString(color, 16)` — the exact channel format a
 *  visible renderer xterm uses in OSC 4/10/11/12 query replies. */
export function formatXColorRgbSpec(rgb: TerminalViewRgb): string {
  return `rgb:${padChannelTo16Bit(rgb[0])}/${padChannelTo16Bit(rgb[1])}/${padChannelTo16Bit(rgb[2])}`
}

function rgbEqual(a: TerminalViewRgb, b: TerminalViewRgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** Value equality over the whole snapshot. Lets main's store treat a
 *  re-push of identical attributes (fresh renderer process: second window,
 *  reload, macOS re-activation) as a no-op instead of a theme apply. */
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

/** IPC-boundary validation for the `pty:terminalViewAttributes` push. Returns
 *  a normalized copy or null — main must never store a malformed palette (a
 *  wrong color reply is worse than silence, the OSC-11 lesson). */
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
