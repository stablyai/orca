import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'

export function captureScrollState(terminal: Terminal): ScrollState {
  const buf = terminal.buffer.active
  return {
    bufferType: buf.type,
    wasAtBottom: buf.viewportY >= buf.baseY,
    viewportY: buf.viewportY,
    baseY: buf.baseY
  }
}

export function restoreScrollState(terminal: Terminal, state: ScrollState): void {
  const buf = terminal.buffer.active
  if (state.bufferType === 'alternate' || buf.type !== state.bufferType) {
    return
  }

  if (state.wasAtBottom) {
    terminal.scrollToBottom()
    forceViewportScrollbarSync(terminal)
    return
  }

  terminal.scrollToLine(Math.min(state.viewportY, buf.baseY))
  forceViewportScrollbarSync(terminal)
}

// Why: xterm 6 can leave its scrollbar thumb stale when ydisp is unchanged.
// A synchronous one-line jiggle updates the scrollbar without a visible paint.
function forceViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY > 0) {
    terminal.scrollLines(-1)
    terminal.scrollLines(1)
  } else if (buf.viewportY < buf.baseY) {
    terminal.scrollLines(1)
    terminal.scrollLines(-1)
  }
}
