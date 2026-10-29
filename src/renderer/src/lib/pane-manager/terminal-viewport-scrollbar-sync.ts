import type { Terminal } from '@xterm/xterm'

// xterm 6 can leave the thumb stale at unchanged ydisp; a synchronous one-line jiggle updates it without visible paint.
export function forceTerminalViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY >= buf.baseY) {
    // At bottom use scrollToBottom; jiggle would stop live following after split resize.
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
