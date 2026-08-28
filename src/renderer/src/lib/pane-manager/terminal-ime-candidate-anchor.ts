import type { Terminal } from '@xterm/xterm'
import { resolveCursorAgentImeAnchor, type TerminalImeAnchor } from './terminal-ime-anchor'

type ImeAnchorCellMetrics = {
  cellWidth: number
  cellHeight: number
  cols: number
  rows: number
}

type ImeAnchorStyleProperty = 'top' | 'left' | 'height' | 'lineHeight'

/**
 * Keep the OS IME candidate window anchored to the cell the user is typing in.
 *
 * Why: the OS reads the focused textarea's screen rect at compositionstart to
 * decide where to display the candidate window. xterm positions that textarea
 * from its own cursor, which can be stale or intentionally hidden by TUIs. We
 * force-sync after xterm's own composition handlers so the OS sees the corrected
 * location before it opens the candidate window.
 *
 * xterm rewrites the textarea's position from its own `compositionupdate`
 * handler, so the update listener has to stay — CJK IMEs compose long sequences
 * (romaji→kana→kanji, pinyin phrases) during which xterm's uncorrected position
 * would otherwise win. Instead the update path is made free of forced layout:
 * cell metrics are measured once per composition and reused, and a style write is
 * skipped when the inline value already matches (a CSSOM read, not a layout one).
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
  const compositionView = terminal.element.querySelector<HTMLElement>('.composition-view')
  const textarea = terminal.textarea
  let metrics: ImeAnchorCellMetrics | null = null
  let deferredApply: number | null = null
  let cursorAgentSeen = false

  const measureCells = (): ImeAnchorCellMetrics | null => {
    if (!screenElement) {
      return null
    }
    const rect = screenElement.getBoundingClientRect()
    const cellWidth = rect.width / terminal.cols
    const cellHeight = rect.height / terminal.rows
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
      return null
    }
    return { cellWidth, cellHeight, cols: terminal.cols, rows: terminal.rows }
  }

  // Why: xterm rewrites these between our events, so compare against the live
  // inline value — a CSSOM read, unlike getBoundingClientRect — and skip the
  // write when it already matches instead of re-invalidating layout.
  const writeStyle = (
    element: HTMLElement,
    property: ImeAnchorStyleProperty,
    value: string
  ): void => {
    if (element.style[property] !== value) {
      element.style[property] = value
    }
  }

  const applyAnchor = (
    row: number,
    column: number,
    cells: ImeAnchorCellMetrics,
    isCursorAgent: boolean
  ): void => {
    const top = `${row * cells.cellHeight}px`
    const left = `${column * cells.cellWidth}px`
    writeStyle(textarea, 'top', top)
    writeStyle(textarea, 'left', left)
    if (isCursorAgent && compositionView) {
      const height = `${cells.cellHeight}px`
      writeStyle(compositionView, 'top', top)
      writeStyle(compositionView, 'left', left)
      writeStyle(compositionView, 'height', height)
      writeStyle(compositionView, 'lineHeight', height)
    }
  }

  const resolveAnchor = (): { anchor: TerminalImeAnchor; isCursorAgent: boolean } => {
    const buf = terminal.buffer.active
    // Why: Cursor Agent draws its prompt UI while leaving xterm's public cursor
    // on a blank row, so the OS IME anchor needs the rendered prompt row instead.
    const cursorAgentAnchor = resolveCursorAgentImeAnchor({
      buffer: buf,
      rows: terminal.rows,
      cols: terminal.cols,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      knownCursorAgent: cursorAgentSeen
    })
    cursorAgentSeen ||= cursorAgentAnchor !== null
    return {
      anchor: cursorAgentAnchor ?? {
        row: buf.cursorY,
        column: Math.min(buf.cursorX, terminal.cols - 1)
      },
      isCursorAgent: cursorAgentAnchor !== null
    }
  }

  const handler = (event?: Event): void => {
    if (!screenElement) {
      return
    }
    // Re-measure per composition (font size or zoom may have changed since the
    // last one); every compositionupdate then reuses it and forces no layout.
    const staleMetrics =
      !metrics || metrics.cols !== terminal.cols || metrics.rows !== terminal.rows
    if (event?.type !== 'compositionupdate' || staleMetrics) {
      metrics = measureCells()
    }
    const cells = metrics
    if (!cells) {
      return
    }
    const { anchor, isCursorAgent } = resolveAnchor()
    applyAnchor(anchor.row, anchor.column, cells, isCursorAgent)
    // Why: xterm re-positions the textarea from a setTimeout(0) of its own after
    // each compositionupdate, so the correction has to land after that timer —
    // one pending timer per burst, re-reading the anchor when it fires.
    if (!isCursorAgent) {
      if (deferredApply !== null) {
        window.clearTimeout(deferredApply)
        deferredApply = null
      }
      return
    }
    // Re-queue after xterm's latest timer while keeping only one correction pending.
    if (deferredApply !== null) {
      window.clearTimeout(deferredApply)
    }
    deferredApply = window.setTimeout(() => {
      deferredApply = null
      if (!textarea.isConnected) {
        return
      }
      if (!metrics || metrics.cols !== terminal.cols || metrics.rows !== terminal.rows) {
        metrics = measureCells()
      }
      if (metrics) {
        const current = resolveAnchor()
        applyAnchor(current.anchor.row, current.anchor.column, metrics, current.isCursorAgent)
      }
    }, 0)
  }

  terminal.element.addEventListener('compositionstart', handler)
  terminal.element.addEventListener('compositionupdate', handler)
  return handler
}
