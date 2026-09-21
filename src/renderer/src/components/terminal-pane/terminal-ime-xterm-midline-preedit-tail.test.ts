// @vitest-environment happy-dom
/**
 * A mid-line composition must not visually swallow the character after the cursor.
 *
 * The preedit overlay (`.composition-view`) is an opaque box anchored to the cursor cell. Nothing
 * reaches the PTY while composing, so the covered cells still hold their characters — the box just
 * hides them for the whole composition (#12545). Composing `가` with the cursor before `하` in
 * `안녕하세요` blanks `하` until the syllable commits.
 *
 * The fix renders the rest of the row's committed text after the preedit inside the overlay, so the
 * composition reads as inserted text pushing the tail right. The overlay also follows xterm's live
 * theme service instead of the stock `#000`/`#FFF`, with any alpha dropped — a see-through mask
 * would re-expose the very cells the rendered tail stands in for.
 *
 * happy-dom performs no layout, so the cell size is supplied and geometry is not asserted; the
 * on-screen geometry arm lives in `tests/e2e/terminal-korean-midline-preedit-occlusion.spec.ts`.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCandidateAnchor } from '@/lib/pane-manager/terminal-ime-candidate-anchor'

const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16
const THEME = { background: '#112233', cursor: '#ddeeff', foreground: '#aabbcc' }

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Rig = {
  compositionView: HTMLElement
  compose: (preedit: string) => void
  composeStart: () => void
  composeUpdate: (preedit: string) => void
  terminal: Terminal
  textarea: HTMLTextAreaElement
  write: (data: string) => Promise<void>
  writeAwaitingRender: (data: string) => Promise<void>
}

type RigOptions = {
  cursorWidth?: number
  theme?: { background: string; cursor?: string; foreground: string }
  /** Installs the production candidate-anchor listener, the other writer of `textarea.style`. */
  withCandidateAnchor?: boolean
}

/**
 * happy-dom lays nothing out, so both textarea-geometry owners read zeroes and neither can
 * overflow. This gives the preedit span a width and the screen its cols*rows box.
 */
function stubCompositionLayout(preeditWidth: () => number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('xterm-composition-preedit')) {
        return DOMRect.fromRect({ height: CELL_HEIGHT_PX, width: preeditWidth() })
      }
      if (this.classList.contains('xterm-screen')) {
        return DOMRect.fromRect({ height: 24 * CELL_HEIGHT_PX, width: 80 * CELL_WIDTH_PX })
      }
      return DOMRect.fromRect({ height: 0, width: 0 })
    }
  )
}

function openTerminal(options: RigOptions = {}): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    theme: options.theme ?? THEME,
    cursorWidth: options.cursorWidth
  })
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push(terminal)
  if (options.withCandidateAnchor && !installTerminalImeCandidateAnchor(terminal)) {
    throw new Error('the candidate anchor did not install on an opened terminal')
  }

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

  // Awaits the repaint the write triggers, so the tail refresh runs through the production
  // terminal.onRender path rather than a test shortcut. The listener arms only after the write's
  // parse callback, because a repaint scheduled by an earlier write can fire first and still show
  // the old row.
  const writeAwaitingRender = async (data: string): Promise<void> => {
    await write(data)
    await new Promise<void>((resolve) => {
      const rendered = terminal.onRender(() => {
        rendered.dispose()
        resolve()
      })
    })
  }

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

  const compose = (preedit: string): void => {
    composeStart()
    composeUpdate(preedit)
  }

  return {
    compositionView,
    compose,
    composeStart,
    composeUpdate,
    terminal,
    textarea,
    write,
    writeAwaitingRender
  }
}

function viewParts(compositionView: HTMLElement): {
  caret: HTMLElement | null
  preedit: HTMLElement | null
  remainder: HTMLElement | null
} {
  return {
    caret: compositionView.querySelector<HTMLElement>('.xterm-composition-caret'),
    preedit: compositionView.querySelector<HTMLElement>('.xterm-composition-preedit'),
    remainder: compositionView.querySelector<HTMLElement>('.xterm-composition-remainder')
  }
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

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret, remainder])
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(preedit!.style.textDecoration).toBe('underline')
    expect(remainder!.textContent).toBe('하세요')
    // Start-anchored so the preedit stays put and the pushed tail clips at the right edge.
    expect(rig.compositionView.style.direction).toBe('ltr')
    expect(rig.compositionView.style.display).toBe('')
    expect(rig.compositionView.style.justifyContent).toBe('')
  })

  it('keeps the tail current as the preedit grows through the composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    // One composition stays active while the preedit grows through updates,
    // matching how an IME actually streams ㄱ → 가 → 강.
    rig.composeStart()
    rig.composeUpdate('ㄱ')
    rig.composeUpdate('가')
    rig.composeUpdate('강')

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret, remainder])
    expect(stripMarks(preedit!.textContent)).toBe('강')
    expect(remainder!.textContent).toBe('하세요')
  })

  // The view is `white-space: nowrap`, which collapses runs of spaces exactly like `normal`.
  // Without `pre` on the tail, a TUI's padded input row — `> text …spaces… |` — renders its
  // right border a cell after the preedit while the real border stays put. xterm sets `pre` on its
  // grid rows for the same reason.
  it('preserves the tail spacing of a padded row so its trailing glyph stays on the grid', async () => {
    const rig = openTerminal()
    // A TUI input row: text, padding, then a real border glyph the trim cannot drop.
    await rig.write('> hi          |\x1b[13D')

    rig.compose('가')

    const { remainder } = viewParts(rig.compositionView)
    expect(remainder!.textContent, 'the tail must keep every padding cell').toBe('hi          |')
    expect(
      remainder!.style.whiteSpace,
      'nowrap collapses the padding, so the border lands left of its grid column'
    ).toBe('pre')
  })

  it('keeps the plain single-text overlay when composing at the end of the row', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요')

    rig.compose('가')

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret])
    expect(remainder).toBeNull()
    expect(stripMarks(rig.compositionView.textContent)).toBe('가')
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
  })

  it('cleans the overlay when the terminal is disposed mid-composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')
    rig.compose('가')
    expect(rig.compositionView.classList.contains('active')).toBe(true)
    expect(viewParts(rig.compositionView).caret).not.toBeNull()

    rig.terminal.dispose()

    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.children).toHaveLength(0)
    expect(rig.compositionView.textContent).toBe('')
    expect(rig.compositionView.style.display).toBe('')
    expect(rig.compositionView.style.justifyContent).toBe('')
  })

  it('keeps the themed insertion caret visible inside the final cell', async () => {
    const rig = openTerminal({ cursorWidth: 2 })
    await rig.write('\x1b[80G')

    rig.compose('가')

    const { caret, preedit } = viewParts(rig.compositionView)
    expect(rig.terminal.buffer.active.cursorX).toBe(79)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret])
    expect(rig.compositionView.style.maxWidth).toBe(`${CELL_WIDTH_PX}px`)
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
    expect(preedit!.style.flexShrink).toBe('0')
    expect(caret!.style.flexShrink).toBe('0')
    expect(caret!.style.width).toBe('2px')
    expect(caret!.style.marginLeft).toBe('-2px')
    expect([THEME.cursor, 'rgb(221, 238, 255)']).toContain(caret!.style.backgroundColor)
  })

  // Both writers of `textarea.style.left` run here on purpose. xterm's listener is on the
  // textarea and the candidate anchor's is on `terminal.element`, so within one event the
  // anchor writes last; a test that installs only one of them proves nothing about which
  // position the OS actually reads at composition time.
  //
  // Neither writer may produce a different answer, because there is no stable "last" writer:
  // CoreBrowserTerminal drives `updateCompositionElements` from `onRender` too, so a render can
  // land after the last composition event this module hears. The render arm is the test below.
  it('keeps the caret and IME candidate anchor visible over committed text in the final cell', async () => {
    const rig = openTerminal({ cursorWidth: 2, withCandidateAnchor: true })
    await rig.write('x'.repeat(80))
    let preeditWidth = CELL_WIDTH_PX * 2
    stubCompositionLayout(() => preeditWidth)

    rig.compose('가')

    const { caret, remainder } = viewParts(rig.compositionView)
    expect(rig.terminal.buffer.active.cursorX).toBe(80)
    expect(remainder!.textContent).toBe('x')
    expect(remainder!.style.display).toBe('none')
    expect(rig.compositionView.style.maxWidth).toBe(`${CELL_WIDTH_PX}px`)
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
    expect(caret!.style.width).toBe('2px')
    expect(rig.textarea.style.left).toBe(`${rig.terminal.cols * CELL_WIDTH_PX - preeditWidth}px`)
    expect(rig.textarea.style.width).toBe(`${preeditWidth}px`)

    preeditWidth = CELL_WIDTH_PX / 2
    await rig.writeAwaitingRender('\x1b[0m')
    expect(remainder!.style.display).toBe('')
    expect(rig.compositionView.style.display).toBe('')
    expect(rig.compositionView.style.justifyContent).toBe('')
    expect(rig.textarea.style.left).toBe(`${(rig.terminal.cols - 1) * CELL_WIDTH_PX}px`)
    expect(rig.textarea.style.width).toBe(`${preeditWidth}px`)
  })

  it('keeps the candidate anchor inside the screen across a render, not just a composition event', async () => {
    // The regression this pins: xterm re-runs updateCompositionElements from onRender, so a
    // repaint with no composition event behind it re-asserts the textarea position on its own.
    // A clamp that lived only in the composition-event listener is reverted here and stays
    // reverted, which is what the OS then samples.
    const rig = openTerminal({ cursorWidth: 2, withCandidateAnchor: true })
    await rig.write('x'.repeat(80))
    stubCompositionLayout(() => CELL_WIDTH_PX * 2)

    rig.compose('가')
    const clamped = `${rig.terminal.cols * CELL_WIDTH_PX - CELL_WIDTH_PX * 2}px`
    expect(rig.textarea.style.left).toBe(clamped)

    // A TUI repaint under the open composition: no composition event, one render.
    await rig.writeAwaitingRender('\x1b[0m')

    expect(rig.textarea.style.left).toBe(clamped)
  })

  it('keeps the default cursor visible on a light background', async () => {
    const rig = openTerminal({
      theme: { background: '#ffffff', foreground: '#223344' }
    })
    await rig.write('안녕')

    rig.compose('한')

    expect(['#868686', 'rgb(134, 134, 134)']).toContain(
      viewParts(rig.compositionView).caret!.style.backgroundColor
    )
  })

  it('cleans the caret and overlay on cancel and an empty resumed update', async () => {
    const rig = openTerminal()
    await rig.write('안녕')
    rig.compose('한')

    expect(viewParts(rig.compositionView).caret).not.toBeNull()

    rig.textarea.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, code: 'Escape', key: 'Escape' })
    )
    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.children).toHaveLength(0)
    expect(rig.compositionView.style.display).toBe('')
    expect(rig.compositionView.style.justifyContent).toBe('')

    rig.composeUpdate('글')
    expect(rig.compositionView.classList.contains('active')).toBe(true)
    expect(viewParts(rig.compositionView).caret).not.toBeNull()
    rig.composeUpdate('')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.children).toHaveLength(0)
    expect(rig.compositionView.style.display).toBe('')
    expect(rig.compositionView.style.justifyContent).toBe('')
  })

  it('keeps arbitrary fully dimmed output visible at column zero', async () => {
    const rig = openTerminal()
    const dimmedRow = 'Waiting for input'
    await rig.write(`\x1b[2m${dimmedRow}\x1b[22m\x1b[${dimmedRow.length}D`)

    rig.compose('아')

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret, remainder])
    expect(stripMarks(preedit!.textContent)).toBe('아')
    expect(remainder!.textContent).toBe(dimmedRow)
    expect(remainder!.style.visibility).toBe('')
  })

  it('keeps a wholly dim mid-line tail visible', async () => {
    const rig = openTerminal()
    const tail = 'status'
    await rig.write(`> \x1b[2m${tail}\x1b[22m\x1b[${tail.length}D`)

    expect(rig.terminal.buffer.active.cursorX).toBe(2)
    rig.compose('아')

    const { remainder } = viewParts(rig.compositionView)
    expect(remainder!.textContent).toBe(tail)
    expect(remainder!.style.visibility).toBe('')
  })

  it('keeps a mixed dim and committed tail visible', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[2mghost\x1b[22m!\x1b[6D')

    rig.compose('아')

    const { remainder } = viewParts(rig.compositionView)
    expect(remainder!.textContent).toBe('ghost!')
    expect(remainder!.style.visibility).toBe('')
  })

  it('themes the overlay from options.theme instead of the stock #000/#FFF', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    const { background, color } = rig.compositionView.style
    expect([THEME.background, 'rgb(17, 34, 51)']).toContain(background)
    expect([THEME.foreground, 'rgb(170, 187, 204)']).toContain(color)
  })

  it('follows a live OSC 12 cursor-color change during composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕')
    rig.compose('한')
    expect([THEME.cursor, 'rgb(221, 238, 255)']).toContain(
      viewParts(rig.compositionView).caret!.style.backgroundColor
    )

    await rig.writeAwaitingRender('\x1b]12;#cc5500\x07')

    expect(['#cc5500', 'rgb(204, 85, 0)']).toContain(
      viewParts(rig.compositionView).caret!.style.backgroundColor
    )
  })

  it('drops the alpha of a translucent theme background so the mask stays opaque', async () => {
    // terminalBackgroundOpacity composes theme.background down to rgba(); carried through as-is it
    // would let the covered cells show straight through the tail this renders.
    const rig = openTerminal({
      theme: { background: 'rgba(17, 34, 51, 0.6)', foreground: '#aabbcc' }
    })
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    expect(['#112233', 'rgb(17, 34, 51)']).toContain(rig.compositionView.style.background)
    expect(rig.compositionView.style.background).not.toMatch(/^rgba/i)
  })

  it('refreshes the tail when the row repaints under an open composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')
    rig.compose('가')

    // A TUI repaint: erase from the cursor, draw a different tail, put the cursor back.
    await rig.writeAwaitingRender('\x1b[K체크\x1b[4D')

    const { preedit, remainder } = viewParts(rig.compositionView)
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(remainder!.textContent).toBe('체크')
  })

  it('starts rendering a tail when text lands after an end-of-row composition began', async () => {
    const rig = openTerminal()
    await rig.write('안녕')
    rig.compose('가')
    expect(viewParts(rig.compositionView).remainder).toBeNull()

    // Streamed output arrives to the right of the cursor while the composition is open.
    await rig.writeAwaitingRender('하세요\x1b[6D')

    const { preedit, remainder } = viewParts(rig.compositionView)
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(remainder!.textContent).toBe('하세요')
  })

  it('leaves no tail behind for the next composition after one ends', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')
    rig.compose('가')

    const end = new CompositionEvent('compositionend', { bubbles: true })
    Object.defineProperty(end, 'data', { value: '가' })
    rig.terminal.textarea!.dispatchEvent(end)
    await nextEventLoop()
    await nextEventLoop()

    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.children).toHaveLength(0)
    expect(rig.compositionView.textContent).toBe('')
  })
})
