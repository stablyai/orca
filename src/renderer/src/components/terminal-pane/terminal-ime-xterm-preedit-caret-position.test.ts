// @vitest-environment happy-dom
/**
 * Bopomofo and Japanese IMEs let the user walk the insertion point back through an open preedit
 * (←/→) and pick a candidate for the character there. The composition caret used to be pinned to
 * the end of the preedit, so after moving left nothing on screen showed which character the next
 * candidate would replace.
 *
 * Chromium mirrors the IME's insertion point into the helper textarea's selection once it applies
 * the marked text, so the caret is painted back over the cells of preedit that follow it. happy-dom
 * performs no layout, so the cell size is supplied and only the caret styles are asserted; the e2e
 * spec checks the resulting geometry.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16
const CURSOR_WIDTH_PX = 1

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Rig = {
  caret: () => HTMLElement | null
  composeStart: () => void
  /** Applies the preedit the way Chromium does: event first, then the textarea and its selection. */
  composeUpdate: (preedit: string, insertionPoint?: number) => Promise<void>
  textarea: HTMLTextAreaElement
}

function openTerminal(): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24, cursorWidth: CURSOR_WIDTH_PX })
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push(terminal)

  const cell = (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { height: number; width: number } } } }
      }
    }
  )._core._renderService.dimensions.css.cell
  cell.width = CELL_WIDTH_PX
  cell.height = CELL_HEIGHT_PX

  const composeStart = (): void => {
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    Object.defineProperty(start, 'data', { value: '' })
    textarea.dispatchEvent(start)
  }

  const composeUpdate = async (preedit: string, insertionPoint?: number): Promise<void> => {
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: preedit })
    textarea.dispatchEvent(update)
    textarea.value = preedit
    const caret = insertionPoint ?? preedit.length
    textarea.setSelectionRange(caret, caret)
    await nextEventLoop()
    await nextEventLoop()
  }

  return {
    caret: () => compositionView.querySelector<HTMLElement>('.xterm-composition-caret'),
    composeStart,
    composeUpdate,
    textarea
  }
}

/**
 * The caret keeps a zero advance (its margin cancels its own width) and is only painted back over
 * the cells after the insertion point, drawn from that point rightwards, so the preedit and the
 * row tail keep their layout.
 */
function expectCaretOverCells(caret: HTMLElement | null, cellsAfterCaret: number): void {
  expect(caret?.style.marginLeft).toBe(`${-CURSOR_WIDTH_PX}px`)
  expect(caret?.style.transform).toBe(
    cellsAfterCaret === 0
      ? ''
      : `translateX(${CURSOR_WIDTH_PX - cellsAfterCaret * CELL_WIDTH_PX}px)`
  )
}

describe('composition caret follows the IME insertion point', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(async () => {
    // updateCompositionElements re-arms on a timer; let the pending one run before dispose.
    await nextEventLoop()
    await nextEventLoop()
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('keeps the caret at the end while the insertion point is at the end', async () => {
    const rig = openTerminal()
    rig.composeStart()

    await rig.composeUpdate('你好嗎')

    expectCaretOverCells(rig.caret(), 0)
  })

  it('pulls the caret back over the wide characters after a mid-preedit insertion point', async () => {
    const rig = openTerminal()
    rig.composeStart()
    await rig.composeUpdate('你好嗎')

    // ← twice: the insertion point sits between 你 and 好.
    await rig.composeUpdate('你好嗎', 1)

    expectCaretOverCells(rig.caret(), 4)
  })

  it('moves the caret to the start of the preedit', async () => {
    const rig = openTerminal()
    rig.composeStart()

    await rig.composeUpdate('你好嗎', 0)

    expectCaretOverCells(rig.caret(), 6)
  })

  it('counts unconverted Bopomofo as wide cells', async () => {
    const rig = openTerminal()
    rig.composeStart()

    await rig.composeUpdate('今天ㄊㄧㄢ', 2)

    expectCaretOverCells(rig.caret(), 6)
  })

  it('keeps the caret in place while Chromium selects the whole preedit to replace it', async () => {
    const rig = openTerminal()
    rig.composeStart()
    await rig.composeUpdate('你好嗎', 2)

    // ←: Chromium dispatches compositionupdate with the whole composition still selected, and
    // only then applies the new insertion point.
    rig.textarea.setSelectionRange(0, 3)
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: '你好嗎' })
    rig.textarea.dispatchEvent(update)

    expectCaretOverCells(rig.caret(), 2)

    rig.textarea.setSelectionRange(1, 1)
    await nextEventLoop()
    await nextEventLoop()

    expectCaretOverCells(rig.caret(), 4)
  })

  it('never splits a surrogate pair at the insertion point', async () => {
    const rig = openTerminal()
    rig.composeStart()

    // Offset 2 is between the two halves of 😀; the caret stays after the whole emoji.
    await rig.composeUpdate('你😀好', 2)

    expectCaretOverCells(rig.caret(), 2)
  })

  it('counts narrow characters as single cells', async () => {
    const rig = openTerminal()
    rig.composeStart()

    await rig.composeUpdate('abc中', 1)

    expectCaretOverCells(rig.caret(), 4)
  })
})
