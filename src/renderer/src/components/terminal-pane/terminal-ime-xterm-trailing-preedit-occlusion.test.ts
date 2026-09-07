// @vitest-environment happy-dom
/**
 * Issue #12729 — typing `가나다라` leaves the last syllable inside an opaque block.
 *
 * The report reads the block as a mis-placed cursor, but no cursor can produce it: the cursor sits
 * on the column the application asked for and a block cursor carries the whole wide glyph
 * (`terminal-cjk-cursor-cell-placement.test.ts`). What sits there is the preedit overlay.
 *
 * macOS 2-set Korean keeps the trailing syllable composing until a terminator, so after four
 * keystrokes only `가나다` has reached the pty; `라` lives in `.composition-view`, an opaque box
 * anchored to the cursor cell. Stock xterm styles that box `#000`/`#FFF` in its own stylesheet,
 * which is the black block the report measured, and no cursor setting can reach it — matching the
 * report's second claim that `terminalCursorStyle` / `terminalCursorOpacity` do nothing.
 *
 * #15014 themed the overlay from `options.theme`; this pins the end-of-row arm of that, which is
 * the shape #12729 hits. happy-dom performs no layout, so the cell size is supplied and only the
 * anchor is asserted, not glyph geometry.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16
const THEME = { background: '#112233', foreground: '#aabbcc' }

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Rig = {
  commit: (syllable: string) => Promise<void>
  compositionView: HTMLElement
  composeUpdate: (preedit: string) => void
  composeStart: () => void
  sent: string[]
  terminal: Terminal
}

function openTerminal(): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24, theme: THEME })
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

  // A local-echo shell: committed syllables come back through the pty and land in the buffer.
  const sent: string[] = []
  terminal.onData((data) => {
    sent.push(data)
    terminal.write(data)
  })

  const composeStart = (): void => {
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    Object.defineProperty(start, 'data', { value: '' })
    textarea.dispatchEvent(start)
  }

  const composeUpdate = (preedit: string): void => {
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: preedit })
    textarea.value = preedit
    textarea.dispatchEvent(update)
  }

  const commit = async (syllable: string): Promise<void> => {
    const end = new CompositionEvent('compositionend', { bubbles: true })
    Object.defineProperty(end, 'data', { value: syllable })
    textarea.dispatchEvent(end)
    textarea.value = ''
    await nextEventLoop()
    await nextEventLoop()
  }

  return { commit, compositionView, composeStart, composeUpdate, sent, terminal }
}

function stripMarks(text: string | null): string {
  return (text ?? '').replaceAll('‎', '')
}

/** Rolling 2-set Korean: each new consonant commits the previous syllable and opens the next. */
async function typeHangulRun(rig: Rig, syllables: readonly string[]): Promise<void> {
  for (let index = 0; index < syllables.length; index++) {
    if (index > 0) {
      await rig.commit(syllables[index - 1]!)
    }
    rig.composeStart()
    rig.composeUpdate(syllables[index]!)
    await nextEventLoop()
  }
}

describe('#12729 — the block over a trailing Korean syllable is the preedit overlay', () => {
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

  it('holds the trailing syllable in the overlay while the earlier ones reach the pty', async () => {
    const rig = openTerminal()

    await typeHangulRun(rig, ['가', '나', '다', '라'])

    expect(rig.sent.join('')).toBe('가나다')
    // Three committed syllables at two cells each: the cursor is at the next free cell.
    expect(rig.terminal.buffer.active.cursorX).toBe(6)
    expect(rig.compositionView.classList.contains('active')).toBe(true)
    expect(stripMarks(rig.compositionView.textContent)).toBe('라')
    // Nothing follows the cursor, so the overlay needs only the preedit and its caret.
    const preedit = rig.compositionView.querySelector('.xterm-composition-preedit')
    const caret = rig.compositionView.querySelector('.xterm-composition-caret')
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret])
    expect(rig.compositionView.querySelector('.xterm-composition-remainder')).toBeNull()
  })

  it('anchors the overlay to the cursor cell so the preedit continues the run', async () => {
    const rig = openTerminal()

    await typeHangulRun(rig, ['가', '나', '다', '라'])

    expect(rig.compositionView.style.left).toBe(`${6 * CELL_WIDTH_PX}px`)
    expect(rig.compositionView.style.height).toBe(`${CELL_HEIGHT_PX}px`)
    // Synced to the grid's font so the preedit keeps the advance the committed syllables have.
    expect(rig.compositionView.style.fontFamily).toBe(rig.terminal.options.fontFamily)
    expect(rig.compositionView.style.fontSize).toBe(`${rig.terminal.options.fontSize}px`)
  })

  it('themes the trailing overlay instead of the stock opaque #000/#FFF block', async () => {
    const rig = openTerminal()

    await typeHangulRun(rig, ['가', '나', '다', '라'])

    const { background, color } = rig.compositionView.style
    expect([THEME.background, 'rgb(17, 34, 51)']).toContain(background)
    expect([THEME.foreground, 'rgb(170, 187, 204)']).toContain(color)
  })

  it('clears the overlay once the trailing syllable commits', async () => {
    const rig = openTerminal()
    await typeHangulRun(rig, ['가', '나', '다', '라'])

    await rig.commit('라')

    expect(rig.sent.join('')).toBe('가나다라')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.textContent).toBe('')
    // The whole run is now committed cells, with the cursor after it.
    expect(rig.terminal.buffer.active.cursorX).toBe(8)
  })
})
