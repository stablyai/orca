import type { IDisposable, Terminal } from '@xterm/xterm'
import { resolveAppDrawnImeCaret, type TerminalImeAnchor } from './terminal-ime-anchor'

type ImeAnchorCellMetrics = {
  cellWidth: number
  cellHeight: number
  cols: number
  rows: number
}

// An app-drawn caret only stays valid while the viewport and grid stay put.
type AppDrawnCaret = TerminalImeAnchor & {
  baseY: number
  cols: number
  rows: number
}

type ImeAnchorStyleProperty = 'top' | 'left' | 'height' | 'lineHeight'

/** OS candidate placement reads the focused textarea at compositionstart; correct xterm’s stale/hidden TUI cursor after its handlers. Keep compositionupdate correction for long CJK sequences, and follow xterm renders while a composition is anchored on an app-drawn caret, measuring public .xterm-screen bounds and rechecking the last caret before rescanning and skipping unchanged inline styles to avoid layout. Return a cleanup, or null before DOM open. */
export function installTerminalImeCandidateAnchor(terminal: Terminal): (() => void) | null {
  if (!terminal.element || !terminal.textarea) {
    return null
  }
  const screenElement = terminal.element.querySelector<HTMLElement>('.xterm-screen')
  const compositionView = terminal.element.querySelector<HTMLElement>('.composition-view')
  const textarea = terminal.textarea
  let metrics: ImeAnchorCellMetrics | null = null
  let deferredApply: number | null = null
  let renderSubscription: IDisposable | null = null
  let lastCaret: AppDrawnCaret | null = null

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

  // xterm rewrites these between events; compare live inline styles (CSSOM only) to avoid needless layout invalidation.
  const writeStyle = (
    element: HTMLElement,
    property: ImeAnchorStyleProperty,
    value: string
  ): void => {
    if (element.style[property] !== value) {
      element.style[property] = value
    }
  }

  // Match xterm’s patched preedit-width clamp or this later listener would undo its onRender/composition correction until another render. Use xterm’s live inline width to avoid layout.
  const anchorLeft = (column: number, cells: ImeAnchorCellMetrics): number => {
    const cursorLeft = column * cells.cellWidth
    const width = Number.parseFloat(textarea.style.width)
    if (!Number.isFinite(width)) {
      return cursorLeft
    }
    return Math.max(0, Math.min(cursorLeft, cells.cols * cells.cellWidth - width))
  }

  const applyAnchor = (
    row: number,
    column: number,
    cells: ImeAnchorCellMetrics,
    isRelocated: boolean
  ): void => {
    const top = `${row * cells.cellHeight}px`
    const left = `${column * cells.cellWidth}px`
    writeStyle(textarea, 'top', top)
    writeStyle(textarea, 'left', `${anchorLeft(column, cells)}px`)
    if (isRelocated && compositionView) {
      const height = `${cells.cellHeight}px`
      writeStyle(compositionView, 'top', top)
      writeStyle(compositionView, 'left', left)
      writeStyle(compositionView, 'height', height)
      writeStyle(compositionView, 'lineHeight', height)
    }
  }

  const resolveAnchor = (): { anchor: TerminalImeAnchor; isRelocated: boolean } => {
    const buf = terminal.buffer.active
    const cursorVisible = terminal.modes.showCursor
    const knownCaret =
      lastCaret &&
      lastCaret.baseY === buf.baseY &&
      lastCaret.cols === terminal.cols &&
      lastCaret.rows === terminal.rows
        ? lastCaret
        : undefined
    // An app that hides the cursor draws its own caret and parks the real one elsewhere.
    const caret = resolveAppDrawnImeCaret({
      buffer: buf,
      rows: terminal.rows,
      cols: terminal.cols,
      cursorVisible,
      knownCaret
    })
    // A repaint split across writes can briefly paint no caret; within one composition the last one still holds.
    const anchor = caret ?? (cursorVisible ? null : (knownCaret ?? null))
    lastCaret = anchor
      ? {
          row: anchor.row,
          column: anchor.column,
          baseY: buf.baseY,
          cols: terminal.cols,
          rows: terminal.rows
        }
      : null
    return {
      anchor: anchor
        ? { row: anchor.row, column: anchor.column }
        : { row: buf.cursorY, column: Math.min(buf.cursorX, terminal.cols - 1) },
      isRelocated: anchor !== null
    }
  }

  const handler = (event?: Event): void => {
    if (!screenElement) {
      return
    }
    // Measure once per composition to pick up zoom/font changes without layout on every update or render.
    const staleMetrics =
      !metrics || metrics.cols !== terminal.cols || metrics.rows !== terminal.rows
    if (event?.type === 'compositionstart') {
      lastCaret = null
      metrics = measureCells()
    } else if (staleMetrics) {
      metrics = measureCells()
    }
    const cells = metrics
    if (!cells) {
      return
    }
    const { anchor, isRelocated } = resolveAnchor()
    applyAnchor(anchor.row, anchor.column, cells, isRelocated)
    // xterm resets the preedit to the buffer cursor on every render; follow renders only while composing.
    // A hidden cursor without a caret may be a repaint gap, so follow until the caret is painted.
    if (isRelocated || !terminal.modes.showCursor) {
      renderSubscription ??= terminal.onRender(reapplyAfterRender)
    }
    // xterm repositions in setTimeout(0); correct after its timer, coalescing bursts.
    if (!isRelocated) {
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
    // Reuse this anchor: a buffer change or resize renders again and re-queues with a fresh one.
    deferredApply = window.setTimeout(() => {
      deferredApply = null
      if (textarea.isConnected && terminal.cols === cells.cols && terminal.rows === cells.rows) {
        applyAnchor(anchor.row, anchor.column, cells, true)
      }
    }, 0)
  }

  const stopFollowingRenders = (): void => {
    renderSubscription?.dispose()
    renderSubscription = null
    if (deferredApply !== null) {
      window.clearTimeout(deferredApply)
      deferredApply = null
    }
    lastCaret = null
  }

  const reapplyAfterRender = (): void => {
    if (!compositionView?.classList.contains('active') || !textarea.isConnected) {
      stopFollowingRenders()
      return
    }
    handler()
  }

  const element = terminal.element
  element.addEventListener('compositionstart', handler)
  element.addEventListener('compositionupdate', handler)
  return () => {
    element.removeEventListener('compositionstart', handler)
    element.removeEventListener('compositionupdate', handler)
    stopFollowingRenders()
  }
}
