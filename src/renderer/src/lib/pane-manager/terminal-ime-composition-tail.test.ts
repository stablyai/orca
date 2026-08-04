// @vitest-environment happy-dom
import { type ITheme, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCompositionTail } from './terminal-ime-composition-tail'

// Move the cursor back three double-width Hangul syllables.
const CURSOR_BACK_3_SYLLABLES = '\u001b[6D'
const CURSOR_HOME = '\u001b[H'
const openTerminals: Terminal[] = []
const cleanups: (() => void)[] = []

type OpenedTerminal = {
  compositionView: HTMLElement
  container: HTMLElement
  screenElement: HTMLElement
  terminal: Terminal
  textarea: HTMLTextAreaElement
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** happy-dom reports a zero-sized screen; 400px over 40 cols keeps the grid at a round 10px. */
function mockCellGrid(screenElement: HTMLElement): void {
  vi.spyOn(screenElement, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 120
  } as DOMRect)
}

function parkViewportAtScrollbackOrigin(terminal: Terminal): void {
  const active = terminal.buffer.active
  const scrolled = {
    get cursorX() {
      return active.cursorX
    },
    get cursorY() {
      return active.cursorY
    },
    get baseY() {
      return active.baseY
    },
    viewportY: 0,
    getLine: (row: number) => active.getLine(row)
  }
  Object.defineProperty(terminal, 'buffer', {
    configurable: true,
    get: () => ({ active: scrolled })
  })
}

function openTerminal(theme?: ITheme): OpenedTerminal {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 40, rows: 6, theme })
  openTerminals.push(terminal)
  terminal.open(container)
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  const screenElement = container.querySelector<HTMLElement>('.xterm-screen')
  if (!compositionView || !screenElement || !terminal.textarea) {
    throw new Error('xterm composition view, screen element, or textarea was not created')
  }
  const cleanup = installTerminalImeCompositionTail(terminal)
  if (!cleanup) {
    throw new Error('composition tail was not installed')
  }
  cleanups.push(cleanup)
  return { compositionView, container, screenElement, terminal, textarea: terminal.textarea }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function tailOf(container: HTMLElement): HTMLElement {
  const tail = container.querySelector<HTMLElement>('.orca-ime-composition-tail')
  if (!tail) {
    throw new Error('composition tail element is missing')
  }
  return tail
}

function compositionEvent(textarea: HTMLTextAreaElement, type: string, data?: string): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

describe('terminal IME composition tail', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('repaints the row remainder that the preedit overlay covers', async () => {
    const { compositionView, container, terminal, textarea } = openTerminal()
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    const buffer = terminal.buffer.active
    expect(
      buffer
        .getLine(buffer.baseY + buffer.cursorY)
        ?.getCell(buffer.cursorX)
        ?.getChars()
    ).toBe('다')

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')

    // The overlay xterm paints still hides 다; the tail restores it past the preedit.
    expect(compositionView.textContent).not.toContain('다')
    const tail = tailOf(container)
    expect(tail.textContent).toBe('다라마')
    expect(tail.style.display).toBe('block')
  })

  it('repaints the cursor row after the buffer has scrolled', async () => {
    const { container, terminal, textarea } = openTerminal()
    // Push the cursor row past the scrollback origin so cursorY no longer indexes it.
    await write(terminal, 'scrolled away\r\n'.repeat(10))
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0)

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')

    expect(tailOf(container).textContent).toBe('다라마')
  })

  it('stays hidden when the cursor is at the end of the row', async () => {
    const { container, terminal, textarea } = openTerminal()
    await write(terminal, '가나다라마')

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')

    expect(tailOf(container).style.display).toBe('none')
  })

  it('clears the tail when the composition ends', async () => {
    const { container, terminal, textarea } = openTerminal()
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')
    expect(tailOf(container).style.display).toBe('block')

    compositionEvent(textarea, 'compositionend', '바')

    expect(tailOf(container).style.display).toBe('none')
    expect(tailOf(container).textContent).toBe('')
  })

  it('re-reads the row when a committed syllable echoes mid-composition', async () => {
    const { container, terminal, textarea } = openTerminal()
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '다')
    expect(tailOf(container).textContent).toBe('다라마')

    // The IME commits 다 and immediately opens the next composition; the shell
    // redraws the reflowed line while that one is still active.
    await write(terminal, `${CURSOR_HOME}가나다다라마${CURSOR_BACK_3_SYLLABLES}`)
    await nextFrame()

    expect(tailOf(container).style.display).toBe('block')
    expect(tailOf(container).textContent).toBe('다라마')
  })

  it('starts the tail on the cell the preedit ends on', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal()
    mockCellGrid(screenElement)
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')

    // Cursor sits on column 4 and 바 budgets two cells, so the tail resumes on column 6.
    expect(tailOf(container).style.left).toBe('60px')
    expect(tailOf(container).style.top).toBe('0px')
  })

  it('places the first composition off the cell grid, not off the unset preedit box', async () => {
    const { compositionView, container, screenElement, terminal, textarea } = openTerminal()
    mockCellGrid(screenElement)
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    // xterm only assigns .composition-view geometry from compositionupdate.
    expect(compositionView.style.left).toBe('')
    compositionEvent(textarea, 'compositionstart')

    expect(tailOf(container).style.left).toBe('40px')
    expect(tailOf(container).style.display).toBe('block')
  })

  it('hides while the viewport is scrolled off the cursor row', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal()
    mockCellGrid(screenElement)
    // Fill the scrollback so the viewport can leave the cursor row behind.
    await write(terminal, '\r\n'.repeat(20))
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    expect(tailOf(container).style.display).toBe('block')
    compositionEvent(textarea, 'compositionend', '바')

    // happy-dom's zero-sized viewport makes scrollToTop a no-op, so park the
    // viewport at the scrollback origin directly.
    parkViewportAtScrollbackOrigin(terminal)
    compositionEvent(textarea, 'compositionstart')

    expect(tailOf(container).style.display).toBe('none')
  })

  it('hides when the viewport leaves the cursor row mid-composition', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal()
    mockCellGrid(screenElement)
    await write(terminal, '\r\n'.repeat(20))
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    expect(tailOf(container).style.display).toBe('block')

    // Scrolling away without ending the composition must not leave the snapshot on screen.
    parkViewportAtScrollbackOrigin(terminal)
    compositionEvent(textarea, 'compositionupdate', '바')

    expect(tailOf(container).style.display).toBe('none')
    expect(tailOf(container).textContent).toBe('')
  })

  it('re-measures the cell grid when the terminal resizes mid-composition', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal()
    mockCellGrid(screenElement)
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    expect(tailOf(container).style.left).toBe('40px')

    // Same pixel width over half the columns doubles the cell width.
    terminal.resize(20, 6)

    expect(tailOf(container).style.left).toBe('80px')
  })

  it('layers a see-through theme background over the opaque surface behind it', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal({
      background: 'rgba(20, 20, 20, 0.5)'
    })
    screenElement.style.backgroundColor = 'rgb(240, 240, 240)'
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')

    const tail = tailOf(container)
    expect(tail.style.backgroundColor).toBe('rgb(240, 240, 240)')
    expect(tail.style.backgroundImage).toContain('rgba(20, 20, 20, 0.5)')
  })

  it('advances each repainted character on the cell grid, not on font metrics', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal()
    mockCellGrid(screenElement)
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')

    const cells = [...tailOf(container).children] as HTMLElement[]
    expect(cells.map((cell) => cell.textContent)).toEqual(['다', '라', '마'])
    // Every Hangul syllable owns two 10px cells regardless of its glyph advance.
    expect(cells.map((cell) => cell.style.width)).toEqual(['20px', '20px', '20px'])
  })

  it('masks with the terminal background when the theme is opaque', async () => {
    const { container, terminal, textarea } = openTerminal({ background: '#112233' })
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')

    expect(tailOf(container).style.backgroundColor).toMatch(/#112233|rgb\(17, 34, 51\)/)
  })

  it.each(['#112233ff', '#123f'])(
    'masks with the terminal background when its alpha hex %s is full',
    async (background) => {
      const { container, screenElement, terminal, textarea } = openTerminal({ background })
      screenElement.style.backgroundColor = 'rgb(240, 240, 240)'
      await write(terminal, '가나다라마')
      await write(terminal, CURSOR_BACK_3_SYLLABLES)

      compositionEvent(textarea, 'compositionstart')

      const tail = tailOf(container)
      expect(tail.style.backgroundColor).toBeTruthy()
      expect(tail.style.backgroundColor).not.toBe('rgb(240, 240, 240)')
      expect(tail.style.backgroundImage).toBe('none')
    }
  )

  it('layers an alpha hex theme background that is not fully opaque', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal({
      background: '#11223380'
    })
    screenElement.style.backgroundColor = 'rgb(240, 240, 240)'
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')

    const tail = tailOf(container)
    expect(tail.style.backgroundColor).toBe('rgb(240, 240, 240)')
    expect(tail.style.backgroundImage).toContain('#11223380')
  })

  it.each(['rgba(20, 20, 20, 0.5)', 'rgb(20 20 20 / 50%)', 'hsla(0, 0%, 8%, 0.5)'])(
    'rejects the see-through theme background %s that would double-expose the cells',
    async (background) => {
      const { container, terminal, textarea } = openTerminal({ background })
      await write(terminal, '가나다라마')
      await write(terminal, CURSOR_BACK_3_SYLLABLES)

      compositionEvent(textarea, 'compositionstart')

      expect(tailOf(container).style.backgroundColor).not.toBe(background)
    }
  )

  it('removes its element and listeners on cleanup', async () => {
    const { container, terminal, textarea } = openTerminal()
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    cleanups.pop()?.()

    expect(container.querySelector('.orca-ime-composition-tail')).toBeNull()
    compositionEvent(textarea, 'compositionstart')
    expect(container.querySelector('.orca-ime-composition-tail')).toBeNull()
  })
})
