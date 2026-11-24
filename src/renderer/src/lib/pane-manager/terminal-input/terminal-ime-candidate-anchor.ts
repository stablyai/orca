import type { IDisposable, Terminal } from '@xterm/xterm'
import { resolveCursorAgentImeAnchor, type TerminalImeAnchor } from './terminal-ime-anchor'

type ImeAnchorCellMetrics = {
  cellWidth: number
  cellHeight: number
  cols: number
  rows: number
}

// The prompt row only stays valid while the parked cursor and viewport stay put.
type CursorAgentPromptCache = {
  row: number
  cursorY: number
  baseY: number
  cols: number
  rows: number
}

type ImeAnchorStyleProperty = 'top' | 'left' | 'height' | 'lineHeight'

/** OS candidate placement reads the focused textarea at compositionstart; correct xterm’s stale/hidden TUI cursor after its handlers. Keep compositionupdate correction for long CJK sequences, and follow xterm renders while a Cursor Agent composition is active, measuring public .xterm-screen bounds and resolving the prompt row once per composition and skipping unchanged inline styles to avoid layout. Return a cleanup, or null before DOM open. */
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
  let renderSubscription: IDisposable | null = null
  let promptCache: CursorAgentPromptCache | null = null

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
    isCursorAgent: boolean
  ): void => {
    const top = `${row * cells.cellHeight}px`
    const left = `${column * cells.cellWidth}px`
    writeStyle(textarea, 'top', top)
    writeStyle(textarea, 'left', `${anchorLeft(column, cells)}px`)
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
    // Renders repeat while composing; a bottom-up prompt scan per render is too slow on large grids.
    const promptRow =
      promptCache &&
      promptCache.cursorY === buf.cursorY &&
      promptCache.baseY === buf.baseY &&
      promptCache.cols === terminal.cols &&
      promptCache.rows === terminal.rows
        ? promptCache.row
        : undefined
    // Cursor Agent leaves the public cursor on a blank row; anchor IME to its rendered prompt instead.
    const cursorAgentAnchor = resolveCursorAgentImeAnchor({
      buffer: buf,
      rows: terminal.rows,
      cols: terminal.cols,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      knownCursorAgent: cursorAgentSeen,
      promptRow
    })
    cursorAgentSeen ||= cursorAgentAnchor !== null
    promptCache = cursorAgentAnchor
      ? {
          row: cursorAgentAnchor.row,
          cursorY: buf.cursorY,
          baseY: buf.baseY,
          cols: terminal.cols,
          rows: terminal.rows
        }
      : null
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
    // Measure once per composition to pick up zoom/font changes without layout on every update or render.
    const staleMetrics =
      !metrics || metrics.cols !== terminal.cols || metrics.rows !== terminal.rows
    if (event?.type === 'compositionstart') {
      promptCache = null
      metrics = measureCells()
    } else if (staleMetrics) {
      metrics = measureCells()
    }
    const cells = metrics
    if (!cells) {
      return
    }
    const { anchor, isCursorAgent } = resolveAnchor()
    applyAnchor(anchor.row, anchor.column, cells, isCursorAgent)
    // xterm repositions in setTimeout(0); correct after its timer, coalescing bursts.
    if (!isCursorAgent) {
      if (deferredApply !== null) {
        window.clearTimeout(deferredApply)
        deferredApply = null
      }
      return
    }
    // xterm resets the preedit to the buffer cursor on every render; follow renders only while composing.
    renderSubscription ??= terminal.onRender(reapplyAfterRender)
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
    promptCache = null
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
