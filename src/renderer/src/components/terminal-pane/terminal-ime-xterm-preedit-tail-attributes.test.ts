// @vitest-environment happy-dom
/**
 * A rendered composition tail must keep the styling the grid gave its cells.
 *
 * `.composition-view` paints one colour over everything it covers, and the tail it renders after
 * the preedit was emitted as plain text — `translateToString` returns characters and drops every
 * cell attribute. Any cell that was not drawn in the default foreground therefore came back in it:
 * an agent CLI's dim placeholder, still on the row because a composing first syllable never
 * reaches the pty, is redrawn at full brightness and reads as text the user had typed. Continuing
 * to type clears it, and Enter submits only the composed syllable, which is what places the defect
 * in the overlay rather than in the buffer.
 *
 * The tail is now split into runs of cells that render the same way, each carrying the colour and
 * flags the grid resolved for it. A run that needs nothing keeps inheriting the view's colour, so
 * the default case renders exactly as it did.
 *
 * happy-dom performs no layout, so only the emitted DOM is asserted, never geometry.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const THEME = { background: '#112233', foreground: '#aabbcc' }
/** The theme foreground at half opacity, in either form a DOM may report it. */
const DIMMED_FOREGROUND = ['#aabbcc80', 'rgba(170, 187, 204, 0.5)']
/** The theme's own pair, which an inverse cell renders with, in either form. */
const THEME_BACKGROUND = ['#112233', 'rgb(17, 34, 51)']
const THEME_FOREGROUND = ['#aabbcc', 'rgb(170, 187, 204)']

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type TerminalRenderService = {
  _core: {
    _renderService: {
      dimensions: { css: { cell: { height: number; width: number } } }
    }
  }
}

type Rig = {
  compositionView: HTMLElement
  compose: (preedit: string) => void
  terminal: Terminal
  write: (data: string) => Promise<void>
  writeAwaitingRender: (data: string) => Promise<void>
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

  // The DOM renderer's cell metrics come from layout, which happy-dom never performs, so the
  // suite pins them directly.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the metrics field read on the next line is reached through this, and the test fails loudly if xterm stops providing it.
  const withRenderService = terminal as unknown as TerminalRenderService
  const cell = withRenderService._core._renderService.dimensions.css.cell
  cell.width = 8
  cell.height = 16

  const write = (data: string): Promise<void> =>
    new Promise((resolve) => terminal.write(data, resolve))

  // Awaits the repaint the write triggers so the tail refresh runs through the production
  // terminal.onRender path. Armed after the parse callback, because a repaint scheduled by an
  // earlier write can fire first and still show the old row.
  const writeAwaitingRender = async (data: string): Promise<void> => {
    await write(data)
    await new Promise<void>((resolve) => {
      const rendered = terminal.onRender(() => {
        rendered.dispose()
        resolve()
      })
    })
  }

  const compose = (preedit: string): void => {
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    Object.defineProperty(start, 'data', { value: '' })
    textarea.dispatchEvent(start)
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: preedit })
    textarea.value = preedit
    textarea.dispatchEvent(update)
  }

  return { compositionView, compose, terminal, write, writeAwaitingRender }
}

/** The tail's styled runs. Text nodes are the cells that needed no style of their own. */
function runsOf(tail: HTMLElement): HTMLElement[] {
  return Array.from(tail.children).filter((child) => child instanceof HTMLElement)
}

/** The tail the view renders after the preedit, found by class rather than position. */
function tailOf(view: HTMLElement): HTMLElement {
  const remainder = view.querySelector<HTMLElement>('.xterm-composition-remainder')
  if (!remainder) {
    throw new Error('the composition view rendered no tail')
  }
  return remainder
}

describe('a rendered composition tail keeps its cells’ styling', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    const measuring = { measureText: () => ({ width: 10 }) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WidthCache calls only measureText on the context it is given; nothing else on a canvas context is reachable from this suite.
    const context = measuring as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
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

  it('keeps a dim tail dim instead of redrawing it as entered text', async () => {
    const rig = openTerminal()
    // The shape an agent CLI leaves on the row: SGR 2 hint text the cursor sits in front of.
    await rig.write('\x1b[2mAsk anything\x1b[0m\x1b[12D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('Ask anything')
    const runs = runsOf(tail)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toBe('Ask anything')
    // Dim halves the foreground's opacity, the way the renderer fades a dim cell.
    expect(DIMMED_FOREGROUND).toContain(runs[0]!.style.color)
  })

  it('keeps a palette-coloured tail in its own colour', async () => {
    const rig = openTerminal()
    // SGR 31: red from the theme's ansi palette, not the default foreground.
    await rig.write('\x1b[31merror\x1b[0m\x1b[5D')

    rig.compose('ㄱ')

    const runs = runsOf(tailOf(rig.compositionView))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toBe('error')
    expect(runs[0]!.style.color).not.toBe('')
    expect(runs[0]!.style.color).not.toBe('rgb(170, 187, 204)')
  })

  it('leaves a default-styled tail inheriting the view colour, with no run of its own', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('하세요')
    // Nothing to override, so no span is emitted and the view's own colour still applies.
    expect(tail.children).toHaveLength(0)
  })

  it('splits the tail where its styling changes', async () => {
    const rig = openTerminal()
    await rig.write('ab\x1b[2mcd\x1b[0m\x1b[4D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('abcd')
    const runs = runsOf(tail)
    // Only the dim half needs a span; `ab` stays a bare text node ahead of it.
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toBe('cd')
    expect(tail.childNodes[0]!.textContent).toBe('ab')
  })

  it('carries bold and italic through to the rendered tail', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[1mbold\x1b[0m\x1b[3mital\x1b[0m\x1b[8D')

    rig.compose('ㄱ')

    const runs = runsOf(tailOf(rig.compositionView))
    expect(runs).toHaveLength(2)
    expect(runs[0]!.textContent).toBe('bold')
    expect(runs[0]!.style.fontWeight).toBe('bold')
    expect(runs[1]!.textContent).toBe('ital')
    expect(runs[1]!.style.fontStyle).toBe('italic')
  })

  it('walks a wide CJK tail by cell pairs rather than by cell', async () => {
    const rig = openTerminal()
    // A Hangul syllable occupies two cells: the character sits in the first and the second is a
    // zero-width continuation. Advancing one cell at a time would read that continuation as
    // another character and pad the tail out to twice its width.
    await rig.write('\x1b[2m한글 tail\x1b[0m\x1b[9D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('한글 tail')
    const runs = runsOf(tail)
    expect(runs).toHaveLength(1)
    expect(DIMMED_FOREGROUND).toContain(runs[0]!.style.color)
  })

  it('closes a run on the wide character’s far cell, not on its continuation', async () => {
    const rig = openTerminal()
    // `ab` default, then two dim syllables that end the row. Four of the six cells are wide, and
    // two of those are the zero-width continuations — the ones a per-cell walk would emit as
    // extra runs, and the last of which sits on the trimmed end column.
    await rig.write('ab\x1b[2m한글\x1b[0m\x1b[6D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('ab한글')
    // Exactly two nodes: the bare default text and the dim span. A continuation emitted as a run
    // of its own would add a third, empty one — invisible to `textContent`.
    expect(tail.childNodes).toHaveLength(2)
    expect(tail.childNodes[0]!.textContent).toBe('ab')
    const runs = runsOf(tail)
    expect(runs).toHaveLength(1)
    // The boundary falls between `b` and `한`, so neither syllable is split or duplicated.
    expect(runs[0]!.textContent).toBe('한글')
    expect(DIMMED_FOREGROUND).toContain(runs[0]!.style.color)
  })

  it('swaps the pair an inverse tail renders with, rather than dropping it', async () => {
    const rig = openTerminal()
    // SGR 7 on default colours: the cell has no colour of its own, so the swap has to come from
    // the theme's own pair rather than from the cell's fg/bg fields.
    await rig.write('\x1b[7minv\x1b[0m\x1b[3D')

    rig.compose('ㄱ')

    const runs = runsOf(tailOf(rig.compositionView))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toBe('inv')
    expect(THEME_BACKGROUND).toContain(runs[0]!.style.color)
    expect(THEME_FOREGROUND).toContain(runs[0]!.style.backgroundColor)
  })

  it('swaps an inverse cell’s own pair, not just the theme’s', async () => {
    const rig = openTerminal()
    // SGR 7 over an explicit truecolour pair. Reading the cell's fields straight through would
    // render the text in its own foreground over its own background — unswapped, and so
    // indistinguishable from the same cell without SGR 7.
    await rig.write('\x1b[38;2;10;20;30m\x1b[48;2;200;100;50m\x1b[7msel\x1b[0m\x1b[3D')

    rig.compose('ㄱ')

    const runs = runsOf(tailOf(rig.compositionView))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toBe('sel')
    expect(['#c86432', 'rgb(200, 100, 50)']).toContain(runs[0]!.style.color)
    expect(['#0a141e', 'rgb(10, 20, 30)']).toContain(runs[0]!.style.backgroundColor)
  })

  it('refreshes the tail when a repaint changes only its colour', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[2mAsk anything\x1b[0m\x1b[12D')
    rig.compose('ㄱ')
    expect(DIMMED_FOREGROUND).toContain(runsOf(tailOf(rig.compositionView))[0]!.style.color)

    // The CLI drops the hint styling but writes the same characters back. Comparing text alone
    // would report no change and leave the faded tail on screen.
    await rig.writeAwaitingRender('\x1b[K\x1b[0mAsk anything\x1b[12D')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('Ask anything')
    expect(tail.children).toHaveLength(0)
  })

  it('carries the underline style and its own colour, not just a plain underline', async () => {
    const rig = openTerminal()
    // SGR 4:3 is a curly underline and SGR 58;5;1 colours the line independently of the text.
    await rig.write('\x1b[4:3m\x1b[58;5;1mwarn\x1b[0m\x1b[4D')

    rig.compose('ㄱ')

    const runs = runsOf(tailOf(rig.compositionView))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.style.textDecorationLine).toBe('underline')
    // Collapsing every variant to a plain underline is what this guards against.
    expect(runs[0]!.style.textDecorationStyle).toBe('wavy')
    expect(runs[0]!.style.textDecorationColor).not.toBe('')
  })

  it('gives an underlined blank something to draw the line under', async () => {
    const rig = openTerminal()
    // A plain space collapses in the view, so the renderer swaps it for a non-breaking one.
    await rig.write('\x1b[4ma b\x1b[0m\x1b[3D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('a\u00a0b')
  })

  it('keeps a run of spaces inside the tail without padding it out to the row width', async () => {
    const rig = openTerminal()
    // Two spaces inside the text and nothing written past it. The trimmed end column keeps the
    // row's remaining untouched cells out, so the text lands on four characters and not eighty.
    await rig.write('a  b\x1b[4D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('a  b')
    // Asserted on the style, not the text: the view is nowrap, and collapsing the run would move
    // every following glyph a cell left while `textContent` still read `a  b`.
    expect(tail.style.whiteSpace).toBe('pre')
  })
})
