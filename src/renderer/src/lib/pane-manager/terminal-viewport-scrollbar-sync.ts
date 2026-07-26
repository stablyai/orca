import type { Terminal } from '@xterm/xterm'

// Why: xterm 6 can leave its scrollbar thumb stale when ydisp is unchanged.
// A synchronous one-line jiggle updates the scrollbar without a visible paint.
export function forceTerminalViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY >= buf.baseY) {
    // Why: jiggle-scrolling at bottom makes xterm stop following active output
    // after split-pane resizes; scrollToBottom already places the thumb there.
    return
  }
  if (buf.viewportY > 0) {
    safeScrollCall(() => terminal.scrollLines(-1))
    safeScrollCall(() => terminal.scrollLines(1))
  } else if (buf.viewportY < buf.baseY) {
    safeScrollCall(() => terminal.scrollLines(1))
    safeScrollCall(() => terminal.scrollLines(-1))
  }
}

function safeScrollCall(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    if (!(error instanceof TypeError) || !/dimensions/.test(error.message)) {
      throw error
    }
  }
}
