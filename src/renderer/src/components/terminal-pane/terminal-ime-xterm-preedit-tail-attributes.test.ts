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

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
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

  const cell = (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { height: number; width: number } } } }
      }
    }
  )._core._renderService.dimensions.css.cell
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

/** The tail span the view renders after the preedit. */
function tailOf(view: HTMLElement): HTMLElement {
  const children = Array.from(view.children) as HTMLElement[]
  expect(children).toHaveLength(2)
  return children[1]!
}

describe('a rendered composition tail keeps its cells’ styling', () => {
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

  it('keeps a dim tail dim instead of redrawing it as entered text', async () => {
    const rig = openTerminal()
    // The shape an agent CLI leaves on the row: SGR 2 hint text the cursor sits in front of.
    await rig.write('\x1b[2mAsk anything\x1b[0m\x1b[12D')

    rig.compose('ㄱ')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('Ask anything')
    const runs = Array.from(tail.children) as HTMLElement[]
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

    const runs = Array.from(tailOf(rig.compositionView).children) as HTMLElement[]
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
    const runs = Array.from(tail.children) as HTMLElement[]
    // Only the dim half needs a span; `ab` stays a bare text node ahead of it.
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toBe('cd')
    expect(tail.childNodes[0]!.textContent).toBe('ab')
  })

  it('carries bold and italic through to the rendered tail', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[1mbold\x1b[0m\x1b[3mital\x1b[0m\x1b[8D')

    rig.compose('ㄱ')

    const runs = Array.from(tailOf(rig.compositionView).children) as HTMLElement[]
    expect(runs).toHaveLength(2)
    expect(runs[0]!.textContent).toBe('bold')
    expect(runs[0]!.style.fontWeight).toBe('bold')
    expect(runs[1]!.textContent).toBe('ital')
    expect(runs[1]!.style.fontStyle).toBe('italic')
  })

  it('refreshes the tail when a repaint changes only its colour', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[2mAsk anything\x1b[0m\x1b[12D')
    rig.compose('ㄱ')
    expect(DIMMED_FOREGROUND).toContain(
      (Array.from(tailOf(rig.compositionView).children)[0] as HTMLElement).style.color
    )

    // The CLI drops the hint styling but writes the same characters back. Comparing text alone
    // would report no change and leave the faded tail on screen.
    await rig.writeAwaitingRender('\x1b[K\x1b[0mAsk anything\x1b[12D')

    const tail = tailOf(rig.compositionView)
    expect(tail.textContent).toBe('Ask anything')
    expect(tail.children).toHaveLength(0)
  })

  it('keeps a run of spaces inside the tail without padding it out to the row width', async () => {
    const rig = openTerminal()
    // Two spaces inside the text and nothing written past it. The tail has to keep the inner run —
    // the view is nowrap, which would collapse it — while the trimmed end column keeps the row's
    // remaining untouched cells out, so this lands on four characters and not eighty.
    await rig.write('a  b\x1b[4D')

    rig.compose('ㄱ')

    expect(tailOf(rig.compositionView).textContent).toBe('a  b')
  })
})
