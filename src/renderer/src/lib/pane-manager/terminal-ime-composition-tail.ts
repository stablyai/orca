import type { IBufferLine, Terminal } from '@xterm/xterm'
import { measureTerminalStringColumns } from '../../../../shared/terminal-unicode-provider'

/** Null when the color carries no alpha channel at all; otherwise 0..1. */
function readFunctionalAlpha(argumentList: string): number | null {
  const slash = argumentList.lastIndexOf('/')
  const legacy = argumentList.split(',')
  const raw = slash >= 0 ? argumentList.slice(slash + 1) : legacy.length === 4 ? legacy[3] : null
  if (raw == null) {
    return null
  }
  const trimmed = raw.trim()
  const percent = trimmed.endsWith('%')
  const alpha = Number.parseFloat(percent ? trimmed.slice(0, -1) : trimmed)
  if (!Number.isFinite(alpha)) {
    // `none`, custom properties: assume see-through rather than mask with an unknown.
    return 0
  }
  return percent ? alpha / 100 : alpha
}

/** The tail masks the cells it repaints, so a see-through color would double-expose them. */
function isOpaqueColor(color: string | undefined): boolean {
  const value = color?.trim().toLowerCase()
  if (!value || value === 'transparent') {
    return false
  }
  // Covers rgb/rgba/hsl/hsla/hwb/lab/oklch in both the legacy comma and the slash-alpha forms.
  const functional = /^[a-z]+\(([^()]*)\)$/.exec(value)
  if (functional) {
    const alpha = readFunctionalAlpha(functional[1])
    return alpha == null || alpha >= 1
  }
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (!/^[\da-f]+$/.test(hex)) {
      return false
    }
    // #rgba and #rrggbbaa still mask when the alpha channel is full.
    if (hex.length === 4) {
      return hex[3] === 'f'
    }
    if (hex.length === 8) {
      return hex.slice(6) === 'ff'
    }
    return hex.length === 3 || hex.length === 6
  }
  return true
}

function findOpaqueSurface(start: Element): string {
  let element: Element | null = start
  while (element) {
    const background = window.getComputedStyle(element).backgroundColor
    if (isOpaqueColor(background)) {
      return background
    }
    element = element.parentElement
  }
  return '#000'
}

/**
 * What the covered cells actually sit on. A translucent terminal background —
 * `terminalBackgroundOpacity` bakes the alpha into `theme.background`, and
 * xterm then leaves the viewport translucent too — is layered over the first
 * opaque surface behind it rather than swapped for one, so the mask matches the
 * row it replaces instead of falling back to a black block on a light theme.
 */
function resolveBackdrop(
  terminal: Terminal,
  surfaceProbe: Element
): { color: string; overlay: string | null } {
  const themeBackground = terminal.options.theme?.background
  if (isOpaqueColor(themeBackground)) {
    return { color: themeBackground ?? '', overlay: null }
  }
  return {
    color: findOpaqueSurface(surfaceProbe),
    overlay: themeBackground && themeBackground !== 'transparent' ? themeBackground : null
  }
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
  let cellHeight = 0
  let screenWidth = 0
  let repaintFrame: number | null = null

  const measureCellGrid = (): void => {
    const screenRect = screenElement.getBoundingClientRect()
    screenWidth = screenRect.width
    cellWidth = terminal.cols > 0 ? screenRect.width / terminal.cols : 0
    cellHeight = terminal.rows > 0 ? screenRect.height / terminal.rows : 0
  }

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

  // cursorY is viewport-relative; getLine indexes the whole buffer, scrollback included.
  // A viewport scrolled off the cursor row leaves nothing to mask on screen.
  const readCursorLine = (): IBufferLine | undefined => {
    const buffer = terminal.buffer.active
    if (
      buffer.cursorY < 0 ||
      buffer.cursorY >= terminal.rows ||
      buffer.viewportY !== buffer.baseY
    ) {
      return undefined
    }
    return buffer.getLine(buffer.baseY + buffer.cursorY)
  }

  const readRowTail = (): string =>
    readCursorLine()?.translateToString(true, terminal.buffer.active.cursorX) ?? ''

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
    const line = readCursorLine()
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
   * Place the tail off the cell grid rather than off `.composition-view`. xterm
   * only assigns that element's geometry from `compositionupdate`, so reading it
   * on `compositionstart` would place the first composition of a terminal at the
   * top-left corner; measuring its box would also inherit the bidi marks xterm
   * wraps the preedit in and leave a ragged gap.
   */
  const resolveTailGeometry = (): { left: number; top: string; height: string } => {
    const buffer = terminal.buffer.active
    const preeditColumns = measureTerminalStringColumns(terminal, preedit) ?? preedit.length
    if (cellWidth > 0 && cellHeight > 0) {
      const column = Math.min(buffer.cursorX, terminal.cols - 1) + preeditColumns
      return {
        left: column * cellWidth,
        top: `${buffer.cursorY * cellHeight}px`,
        height: `${cellHeight}px`
      }
    }
    const preeditLeft = Number.parseFloat(compositionView.style.left || '0')
    return {
      left: preeditLeft + compositionView.offsetWidth,
      top: compositionView.style.top,
      height: compositionView.style.height
    }
  }

  const paint = (): void => {
    if (!isComposing || !rowTail) {
      return
    }
    const { left, top, height } = resolveTailGeometry()
    tailElement.style.left = `${left}px`
    tailElement.style.top = top
    tailElement.style.height = height
    tailElement.style.lineHeight = height
    tailElement.style.fontFamily = terminal.options.fontFamily ?? compositionView.style.fontFamily
    tailElement.style.fontSize = terminal.options.fontSize
      ? `${terminal.options.fontSize}px`
      : compositionView.style.fontSize
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
    const backdrop = resolveBackdrop(terminal, screenElement)
    tailElement.style.backgroundColor = backdrop.color
    tailElement.style.backgroundImage = backdrop.overlay
      ? `linear-gradient(${backdrop.overlay}, ${backdrop.overlay})`
      : 'none'
    measureCellGrid()
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
  // A resize or font change mid-composition invalidates the snapshotted grid.
  const resizeDisposable = terminal.onResize(() => {
    if (isComposing) {
      measureCellGrid()
      resnapshotAndPaint()
    }
  })

  return () => {
    terminal.element?.removeEventListener('compositionstart', handleCompositionStart)
    terminal.element?.removeEventListener('compositionupdate', handleCompositionUpdate)
    terminal.element?.removeEventListener('compositionend', handleCompositionEnd)
    writeDisposable.dispose()
    resizeDisposable.dispose()
    cancelScheduledRepaint()
    tailElement.remove()
  }
}
