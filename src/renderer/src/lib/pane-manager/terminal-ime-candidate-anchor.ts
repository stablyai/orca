import type { Terminal } from '@xterm/xterm'
import { resolveCursorAgentImeAnchor } from './terminal-ime-anchor'

/**
 * Keep the OS IME candidate window anchored to the cell the user is typing in.
 *
 * Why: the OS reads the focused textarea's screen rect at compositionstart to
 * decide where to display the candidate window. xterm positions that textarea
 * from its own cursor, which can be stale or intentionally hidden by TUIs. We
 * force-sync after xterm's own composition handlers so the OS sees the corrected
 * location before it opens the candidate window.
 *
 * Cell dimensions are derived from the public .xterm-screen element's bounds
 * (xterm sizes that element to cols*cellWidth × rows*cellHeight) rather than
 * poking `_core._renderService.dimensions` — keeps us on the public API surface
 * so upgrades don't silently regress the fix.
 *
 * Returns the installed handler so the caller can remove it on dispose, or null
 * when the terminal has not opened its DOM yet.
 */
export function installTerminalImeCandidateAnchor(terminal: Terminal): (() => void) | null {
  if (!terminal.element || !terminal.textarea) {
    return null
  }
  const screenElement = terminal.element.querySelector<HTMLElement>('.xterm-screen')
  const textarea = terminal.textarea
  const handler = (): void => {
    if (!screenElement) {
      return
    }
    const rect = screenElement.getBoundingClientRect()
    const cellWidth = rect.width / terminal.cols
    const cellHeight = rect.height / terminal.rows
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
      return
    }
    const buf = terminal.buffer.active
    // Why: Cursor Agent draws its prompt UI while leaving xterm's public cursor
    // on a blank row, so the OS IME anchor needs the rendered prompt row instead.
    const cursorAgentAnchor = resolveCursorAgentImeAnchor({
      buffer: buf,
      rows: terminal.rows,
      cols: terminal.cols,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY
    })
    const anchor = cursorAgentAnchor ?? {
      row: buf.cursorY,
      column: Math.min(buf.cursorX, terminal.cols - 1)
    }
    const applyAnchor = (): void => {
      textarea.style.top = `${anchor.row * cellHeight}px`
      textarea.style.left = `${anchor.column * cellWidth}px`
    }
    applyAnchor()
    if (cursorAgentAnchor) {
      window.setTimeout(() => {
        if (textarea.isConnected) {
          applyAnchor()
        }
      }, 0)
    }
  }
  terminal.element.addEventListener('compositionstart', handler)
  terminal.element.addEventListener('compositionupdate', handler)
  return handler
}
