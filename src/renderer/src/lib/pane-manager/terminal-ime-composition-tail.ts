import type { Terminal } from '@xterm/xterm'
import { measureTerminalStringColumns } from '../../../../shared/terminal-unicode-provider'

/** The tail masks the cells it repaints, so a see-through color would double-expose them. */
function isOpaqueColor(color: string | undefined): boolean {
  if (!color || color === 'transparent') {
    return false
  }
  const rgba = /^rgba?\([^)]*?(?:,|\/)\s*(\d*\.?\d+)\s*\)$/.exec(color)
  if (rgba) {
    return Number.parseFloat(rgba[1]) >= 1
  }
  if (color.startsWith('#')) {
    return color.length !== 5 && color.length !== 9
  }
  return true
}

function resolveOpaqueBackdrop(
  terminal: Terminal,
  candidates: (Element | null | undefined)[]
): string {
  if (isOpaqueColor(terminal.options.theme?.background)) {
    return terminal.options.theme?.background ?? ''
  }
  for (const element of candidates) {
    if (!element) {
      continue
    }
    const background = window.getComputedStyle(element).backgroundColor
    if (isOpaqueColor(background)) {
      return background
    }
  }
  // xterm styles .composition-view opaque, so the preedit box itself always is.
  return '#000'
}

/**
 * Keep the text after the cursor readable while an IME composition is open.
 *
 * Why: xterm paints the preedit into an opaque `.composition-view` anchored to
 * the cursor cell, so composing mid-line hides whatever already sits there
 * (stablyai/orca#12545). Nothing reaches the pty until the composition commits,
 * so those cells still hold the old text — we repaint that row remainder just
 * past the preedit, which reads as the insertion pushing it right. macOS
 * Terminal.app behaves the same way; iTerm2 and stock xterm hide it.
 *
 * The tail is its own element rather than a child of `.composition-view`: xterm
 * rewrites that element's textContent on every compositionupdate, clips it with
 * `overflow: hidden`, and flips it to `direction: rtl`.
 *
 * Returns a cleanup function, or null when the terminal has not opened its DOM.
 */
export function installTerminalImeCompositionTail(terminal: Terminal): (() => void) | null {
  const helperContainer = terminal.element?.querySelector<HTMLElement>('.xterm-helpers')
  const compositionView = terminal.element?.querySelector<HTMLElement>('.composition-view')
  const screenElement = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!helperContainer || !compositionView || !screenElement) {
    return null
  }

  const tailElement = document.createElement('div')
  tailElement.className = 'orca-ime-composition-tail'
  tailElement.style.position = 'absolute'
  tailElement.style.display = 'none'
  tailElement.style.whiteSpace = 'pre'
  tailElement.style.direction = 'ltr'
  tailElement.style.overflow = 'hidden'
  tailElement.style.pointerEvents = 'none'
  // Below xterm's preedit box (z-index 1) so a wide glyph never clips it.
  tailElement.style.zIndex = '0'
  helperContainer.appendChild(tailElement)

  let isComposing = false
  let rowTail = ''
  let preedit = ''
  let cellWidth = 0
  let screenWidth = 0
  let repaintFrame: number | null = null

  const cancelScheduledRepaint = (): void => {
    if (repaintFrame != null) {
      cancelAnimationFrame(repaintFrame)
      repaintFrame = null
    }
  }

  const hide = (): void => {
    rowTail = ''
    tailElement.textContent = ''
    tailElement.style.display = 'none'
  }

  const readRowTail = (): string => {
    const buffer = terminal.buffer.active
    if (buffer.cursorY < 0 || buffer.cursorY >= terminal.rows) {
      return ''
    }
    return buffer.getLine(buffer.cursorY)?.translateToString(true, buffer.cursorX) ?? ''
  }

  /**
   * Lay the tail out cell by cell. A plain text node advances on the font's own
   * metrics, which run tighter than the terminal's fixed cell grid and made the
   * repainted text visibly cramped next to the rows around it.
   */
  const renderTailCells = (): void => {
    if (cellWidth <= 0) {
      tailElement.textContent = rowTail
      return
    }
    const buffer = terminal.buffer.active
    const line = buffer.getLine(buffer.cursorY)
    if (!line) {
      tailElement.textContent = rowTail
      return
    }
    const cells: HTMLElement[] = []
    for (let column = buffer.cursorX; column < terminal.cols; column++) {
      const cell = line.getCell(column)
      const columns = cell?.getWidth() ?? 0
      if (!cell || columns === 0) {
        continue
      }
      const cellElement = document.createElement('span')
      cellElement.style.display = 'inline-block'
      cellElement.style.width = `${columns * cellWidth}px`
      cellElement.textContent = cell.getChars() || ' '
      cells.push(cellElement)
    }
    // Stop the mask where the row's content does, not at the right margin.
    while (cells.length > 0 && (cells.at(-1)?.textContent ?? '').trim() === '') {
      cells.pop()
    }
    tailElement.replaceChildren(...cells)
  }

  /**
   * Start the tail on the cell the preedit ends on. Measuring the preedit box
   * instead would inherit the bidi marks xterm wraps it in and leave a ragged
   * gap; the cell budget is what the renderer itself lays text out on.
   */
  const resolveTailLeft = (): number => {
    const preeditLeft = Number.parseFloat(compositionView.style.left || '0')
    if (cellWidth > 0) {
      const columns = measureTerminalStringColumns(terminal, preedit) ?? preedit.length
      return preeditLeft + columns * cellWidth
    }
    return preeditLeft + compositionView.offsetWidth
  }

  const paint = (): void => {
    if (!isComposing || !rowTail) {
      return
    }
    const left = resolveTailLeft()
    tailElement.style.left = `${left}px`
    tailElement.style.top = compositionView.style.top
    tailElement.style.height = compositionView.style.height
    tailElement.style.lineHeight = compositionView.style.lineHeight
    tailElement.style.fontFamily = compositionView.style.fontFamily
    tailElement.style.fontSize = compositionView.style.fontSize
    if (screenWidth > 0) {
      tailElement.style.maxWidth = `${Math.max(screenWidth - left, 0)}px`
    }
    renderTailCells()
    tailElement.style.display = 'block'
  }

  const resnapshotAndPaint = (): void => {
    rowTail = readRowTail()
    if (!rowTail) {
      hide()
      return
    }
    paint()
  }

  const handleCompositionStart = (): void => {
    isComposing = true
    preedit = ''
    tailElement.style.color =
      terminal.options.theme?.foreground ?? window.getComputedStyle(screenElement).color
    tailElement.style.backgroundColor = resolveOpaqueBackdrop(terminal, [
      screenElement,
      terminal.element,
      terminal.element?.parentElement
    ])
    const screenRect = screenElement.getBoundingClientRect()
    screenWidth = screenRect.width
    cellWidth = terminal.cols > 0 ? screenRect.width / terminal.cols : 0
    resnapshotAndPaint()
  }

  const handleCompositionUpdate = (event: Event): void => {
    preedit = (event as CompositionEvent).data ?? ''
    paint()
  }

  const handleCompositionEnd = (): void => {
    isComposing = false
    preedit = ''
    cancelScheduledRepaint()
    hide()
  }

  // Why: every Hangul syllable commits before the next one starts composing, so
  // its echo lands mid-composition — re-read the row instead of dropping the
  // tail, or it stays hidden from the second syllable onwards. Coalesced to one
  // repaint per frame so streamed output cannot thrash layout.
  const handleWriteParsed = (): void => {
    if (!isComposing || repaintFrame != null) {
      return
    }
    repaintFrame = requestAnimationFrame(() => {
      repaintFrame = null
      if (isComposing) {
        resnapshotAndPaint()
      }
    })
  }

  terminal.element?.addEventListener('compositionstart', handleCompositionStart)
  terminal.element?.addEventListener('compositionupdate', handleCompositionUpdate)
  terminal.element?.addEventListener('compositionend', handleCompositionEnd)
  const writeDisposable = terminal.onWriteParsed(handleWriteParsed)

  return () => {
    terminal.element?.removeEventListener('compositionstart', handleCompositionStart)
    terminal.element?.removeEventListener('compositionupdate', handleCompositionUpdate)
    terminal.element?.removeEventListener('compositionend', handleCompositionEnd)
    writeDisposable.dispose()
    cancelScheduledRepaint()
    tailElement.remove()
  }
}
