import type { Terminal } from '@xterm/xterm'
import {
  approximateTerminalCellGeometry,
  resolveTerminalCellGeometry
} from '../terminal-cell-geometry'
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
 * Cell dimensions come from the shared terminal-cell-geometry resolver (the
 * public .xterm-screen bounds, same source as the presence overlays), with the
 * container-size approximation as the pre-first-paint fallback so a composition
 * starting before .xterm-screen is measurable still gets an anchor.
 *
 * Returns the installed handler so the caller can remove it on dispose, or null
 * when the terminal has not opened its DOM yet.
 */
export function installTerminalImeCandidateAnchor(terminal: Terminal): (() => void) | null {
  const container = terminal.element
  if (!container || !terminal.textarea) {
    return null
  }
  const textarea = terminal.textarea
  const handler = (): void => {
    const { cellWidth, cellHeight } =
      resolveTerminalCellGeometry(terminal, container) ??
      approximateTerminalCellGeometry(container, terminal.cols, terminal.rows)
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
