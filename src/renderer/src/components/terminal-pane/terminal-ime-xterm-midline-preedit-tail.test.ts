// @vitest-environment happy-dom
/**
 * A mid-line composition must not visually swallow the character after the cursor.
 *
 * The preedit overlay (`.composition-view`) is an opaque box anchored to the cursor cell.
 * Nothing reaches the PTY while composing, so the covered cells still hold their characters —
 * but the box hides them for the whole composition (#12545). Composing `가` with the cursor
 * before `하` in `안녕하세요` blanks `하` until the syllable commits.
 *
 * The fix renders the rest of the row's committed text after the preedit inside the overlay, so
 * the composition reads as inserted text pushing the tail right — what a native marked-text
 * implementation (Terminal.app) shows. The overlay is also themed from `options.theme` instead
 * of the stock `#000`/`#FFF`, so the rendered tail reads as ordinary terminal text.
 *
 * happy-dom performs no layout, so the cell size is supplied and geometry is not asserted.
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
  compositionView: HTMLElement
  compose: (preedit: string) => void
  terminal: Terminal
  write: (data: string) => Promise<void>
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

  const write = (data: string): Promise<void> =>
    new Promise((resolve) => terminal.write(data, resolve))

  const compose = (preedit: string): void => {
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    Object.defineProperty(start, 'data', { value: '' })
    textarea.dispatchEvent(start)
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: preedit })
    textarea.value = preedit
    textarea.dispatchEvent(update)
  }

  return { compositionView, compose, terminal, write }
}

function stripMarks(text: string | null): string {
  return (text ?? '').replaceAll('‎', '')
}

describe('mid-line composition renders the covered row tail after the preedit', () => {
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

  it('shows the tail from the cursor when composing before committed text (#12545 repro)', async () => {
    const rig = openTerminal()
    // 안녕하세요 then CUB 6: each Hangul syllable is two cells, so the cursor lands on 하 (x=4).
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    const spans = Array.from(rig.compositionView.children) as HTMLElement[]
    expect(spans).toHaveLength(2)
    expect(stripMarks(spans[0]!.textContent)).toBe('가')
    expect(spans[0]!.style.textDecoration).toBe('underline')
    expect(spans[1]!.textContent).toBe('하세요')
    // Start-anchored so the preedit stays visible and the pushed tail clips at the edge.
    expect(rig.compositionView.style.direction).toBe('ltr')
  })

  it('keeps the tail current as the preedit grows through the composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('ㄱ')
    rig.compose('가')
    rig.compose('강')

    const spans = Array.from(rig.compositionView.children) as HTMLElement[]
    expect(spans).toHaveLength(2)
    expect(stripMarks(spans[0]!.textContent)).toBe('강')
    expect(spans[1]!.textContent).toBe('하세요')
  })

  it('keeps the plain single-text overlay when composing at the end of the row', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요')

    rig.compose('가')

    expect(rig.compositionView.children).toHaveLength(0)
    expect(stripMarks(rig.compositionView.textContent)).toBe('가')
    // The rtl trick still keeps a long preedit's end in view when nothing follows the cursor.
    expect(rig.compositionView.style.direction).toBe('rtl')
  })

  it('themes the overlay from options.theme instead of the stock #000/#FFF', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    const { background, color } = rig.compositionView.style
    expect(background.length).toBeGreaterThan(0)
    expect(color.length).toBeGreaterThan(0)
    expect([THEME.background, 'rgb(17, 34, 51)']).toContain(background)
    expect([THEME.foreground, 'rgb(170, 187, 204)']).toContain(color)
  })

  it('refreshes the tail when the row repaints under an open composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')
    rig.compose('가')

    // A TUI repaint: erase from the cursor, draw a different tail, put the cursor back.
    await rig.write('\x1b[K체크\x1b[4D')
    const helper = (
      rig.terminal as unknown as {
        _core: { _compositionHelper: { updateCompositionElements: (d?: boolean) => void } }
      }
    )._core._compositionHelper
    helper.updateCompositionElements(true)

    const spans = Array.from(rig.compositionView.children) as HTMLElement[]
    expect(spans).toHaveLength(2)
    expect(stripMarks(spans[0]!.textContent)).toBe('가')
    expect(spans[1]!.textContent).toBe('체크')
  })

  it('starts rendering a tail when text lands after an end-of-row composition began', async () => {
    const rig = openTerminal()
    await rig.write('안녕')
    rig.compose('가')
    expect(rig.compositionView.children).toHaveLength(0)

    // Streamed output arrives to the right of the cursor while the composition is open.
    await rig.write('하세요\x1b[6D')
    const helper = (
      rig.terminal as unknown as {
        _core: { _compositionHelper: { updateCompositionElements: (d?: boolean) => void } }
      }
    )._core._compositionHelper
    helper.updateCompositionElements(true)

    const spans = Array.from(rig.compositionView.children) as HTMLElement[]
    expect(spans).toHaveLength(2)
    expect(stripMarks(spans[0]!.textContent)).toBe('가')
    expect(spans[1]!.textContent).toBe('하세요')
  })

  it('hides the overlay on compositionend exactly as before', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')
    const end = new CompositionEvent('compositionend', { bubbles: true })
    Object.defineProperty(end, 'data', { value: '가' })
    rig.terminal.textarea!.dispatchEvent(end)
    await nextEventLoop()
    await nextEventLoop()

    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })
})
