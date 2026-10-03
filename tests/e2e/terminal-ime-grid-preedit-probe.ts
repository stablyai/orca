import type { Page } from '@stablyai/playwright-test'

/**
 * Samples the in-grid IME preedit (`imePreeditInGrid`): what xterm publishes for the renderer to
 * draw, and what the renderer's current frame actually holds in those cells.
 *
 * Why both: the published preedit updates synchronously with each composition event, while the
 * renderer paints it on the next frame. A frame that never picks it up is the in-grid form of the
 * zero-size overlay — the user composes blind while every pty-byte assertion still passes — so
 * rendered-state checks must read the renderer (WebGL model cells or DOM row), not the buffer.
 */
export type GridPreeditSample = {
  /** Whether the focused terminal draws its preedit in the cell grid. */
  inGrid: boolean
  /** The preedit xterm has published for the renderer, as drawn cells. */
  text: string
  /** The same cells as the renderer's latest frame holds them. */
  renderedText: string
  renderer: 'webgl' | 'dom' | 'none'
  viewportRow: number
  startColumn: number
  cellCount: number
  /** The drawn cursor's column (the IME caret while composing). */
  cursorColumn: number
  /** The on-screen box the preedit cells occupy. */
  rect: { left: number; top: number; width: number; height: number }
  /** The committed buffer row, which the preedit must never enter. */
  bufferRow: string
  /** The preedit row as xterm asks the renderer to show it. */
  displayedRow: string
  /** Whether every cell of the renderer's frame for that row matches `displayedRow`. */
  rendererMatchesDisplayedRow: boolean
}

export function readGridPreedit(): GridPreeditSample {
  const empty: GridPreeditSample = {
    inGrid: false,
    text: '',
    renderedText: '',
    renderer: 'none',
    viewportRow: -1,
    startColumn: -1,
    cellCount: 0,
    cursorColumn: -1,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    bufferRow: '',
    displayedRow: '',
    rendererMatchesDisplayedRow: false
  }
  const textarea =
    document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus') ??
    document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  let terminal = null
  for (const manager of window.__paneManagers?.values() ?? []) {
    for (const pane of manager.getPanes()) {
      if (pane.terminal.textarea === textarea) {
        terminal = pane.terminal
      }
    }
  }
  if (!terminal || terminal.options.imePreeditInGrid !== true) {
    return empty
  }
  const core = terminal._core
  const buffer = core.buffer
  const cell = core._renderService.dimensions.css.cell
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  const renderer = core._renderService._renderer?.value
  const kind = renderer?._model?.cells
    ? 'webgl'
    : screen?.querySelector('.xterm-rows')
      ? 'dom'
      : 'none'
  const bufferRow = buffer.lines.get(buffer.ybase + buffer.y)?.translateToString(true) ?? ''
  const preedit = core.imePreedit
  if (!preedit) {
    return { ...empty, inGrid: true, renderer: kind, bufferRow }
  }
  const viewportRow = preedit.row - buffer.ydisp
  const startColumn: number = preedit.start
  const cellCount: number = preedit.visibleWidth
  const composed = preedit.composeLine(buffer.lines.get(preedit.row))
  let text = ''
  for (let x = startColumn; x < startColumn + cellCount; x++) {
    text += composed.getString(x)
  }
  const displayedRow = composed.translateToString(true)
  let renderedText = ''
  let rendererMatchesDisplayedRow = false
  if (kind === 'webgl') {
    const cells: Uint32Array = renderer._model.cells
    const renderedCode = (x: number): number =>
      cells[(viewportRow * terminal.cols + x) * 4] & 0x1fffff
    for (let x = startColumn; x < startColumn + cellCount; x++) {
      if (renderedCode(x) !== 0) {
        renderedText += String.fromCodePoint(renderedCode(x))
      }
    }
    rendererMatchesDisplayedRow = true
    for (let x = 0; x < terminal.cols; x++) {
      // Combined cells carry only their last code unit in the model; compare single codepoints.
      if (!composed.isCombined(x) && renderedCode(x) !== composed.getCodePoint(x)) {
        rendererMatchesDisplayedRow = false
      }
    }
  } else if (kind === 'dom') {
    const row = screen?.querySelectorAll('.xterm-rows > div')[viewportRow]
    renderedText = Array.from(
      row?.querySelectorAll('[class*="xterm-underline-"]') ?? [],
      (span) => span.textContent ?? ''
    ).join('')
    rendererMatchesDisplayedRow =
      (row?.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd() === displayedRow
  }
  const screenRect = screen?.getBoundingClientRect()
  return {
    inGrid: true,
    text,
    renderedText,
    renderer: kind,
    viewportRow,
    startColumn,
    cellCount,
    cursorColumn: preedit.cursorX,
    rect: {
      left: (screenRect?.left ?? 0) + startColumn * cell.width,
      top: (screenRect?.top ?? 0) + viewportRow * cell.height,
      width: cellCount * cell.width,
      height: cell.height
    },
    bufferRow,
    displayedRow,
    rendererMatchesDisplayedRow
  }
}

export async function sampleGridPreedit(page: Page): Promise<GridPreeditSample> {
  return page.evaluate(readGridPreedit)
}
