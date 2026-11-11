// xterm marks pointer reports as user input too; callers needing keystrokes must distinguish their byte shape.

/** True for an xterm mouse report (X10 `CSI M` or SGR `CSI <`): pointer input, never a keystroke. */
export function isXtermMouseReport(data: string): boolean {
  return (
    (data.startsWith('\x1b[M') && data.length === 6) ||
    (data.startsWith('\x1b[<') && /^\d+;\d+;\d+[Mm]$/.test(data.slice(3)))
  )
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
