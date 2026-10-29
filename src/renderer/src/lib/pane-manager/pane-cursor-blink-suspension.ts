import type { Terminal } from '@xterm/xterm'

/** Retained hidden WebGL panes can blink without a DOM blur, redrawing full rows. Suspend both public cursorBlink and overriding DEC mode; restore the parked values rather than settings so nonblinking panes stay nonblinking. */
const parkedCursorBlink = new WeakMap<Terminal, boolean>()

export function suspendTerminalCursorBlink(terminal: Terminal): void {
  if (parkedCursorBlink.has(terminal)) {
    return
  }
  parkedCursorBlink.set(terminal, terminal.options.cursorBlink === true)
  terminal.options.cursorBlink = false
}

export function resumeTerminalCursorBlink(terminal: Terminal): void {
  if (!parkedCursorBlink.has(terminal)) {
    return
  }
  const restored = parkedCursorBlink.get(terminal) === true
  parkedCursorBlink.delete(terminal)
  terminal.options.cursorBlink = restored
}

/** Apply settings to parked blink state while hidden; direct option writes would restart the redraw timer. */
export function setTerminalCursorBlinkOption(terminal: Terminal, enabled: boolean): void {
  if (parkedCursorBlink.has(terminal)) {
    parkedCursorBlink.set(terminal, enabled)
    return
  }
  terminal.options.cursorBlink = enabled
}

export function isTerminalCursorBlinkSuspended(terminal: Terminal): boolean {
  return parkedCursorBlink.has(terminal)
}
