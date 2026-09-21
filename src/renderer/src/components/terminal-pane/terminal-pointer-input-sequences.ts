// Why: xterm flags pointer-derived bytes as user input alongside keystrokes; callers
// that must treat pointer input differently need to recognise it by shape.

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
