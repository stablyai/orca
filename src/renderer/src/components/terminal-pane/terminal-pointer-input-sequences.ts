// Why: xterm flags pointer-derived bytes as user input alongside keystrokes; callers
// that must treat pointer input differently need to recognise it by shape.

/** Parses exactly one SGR mouse report (`CSI < b ; x ; y M|m`); null for anything else. */
export function parseSgrMouseReport(
  data: string
): { button: number; x: number; y: number; final: 'M' | 'm' } | null {
  const match = data.startsWith('\x1b[<') ? /^(\d+);(\d+);(\d+)([Mm])$/.exec(data.slice(3)) : null
  if (!match) {
    return null
  }
  const [, button, x, y, final] = match
  return { button: Number(button), x: Number(x), y: Number(y), final: final === 'm' ? 'm' : 'M' }
}

/** True for an xterm mouse report (X10 `CSI M` or SGR `CSI <`): pointer input, never a keystroke. */
export function isXtermMouseReport(data: string): boolean {
  return (data.startsWith('\x1b[M') && data.length === 6) || parseSgrMouseReport(data) !== null
}

/** True for the bare cursor up/down xterm synthesises per wheel notch when the active buffer has no scrollback. */
export function isXtermWheelCursorKey(data: string): boolean {
  return data === '\x1b[A' || data === '\x1b[B' || data === '\x1bOA' || data === '\x1bOB'
}

/** True for a motion report with no button held (any-motion `?1003` hover), in X10 or SGR form. */
export function isXtermHoverMotionReport(data: string): boolean {
  if (!isXtermMouseReport(data)) {
    return false
  }
  const button = data.startsWith('\x1b[<')
    ? Number(data.slice(3, data.indexOf(';')))
    : data.charCodeAt(3) - 32
  // Why the mask: bit 32 is motion, low bits 3 mean no button, 4/8/16 are modifiers, 64+ is wheel.
  return (button & 0xe3) === 0x23
}
