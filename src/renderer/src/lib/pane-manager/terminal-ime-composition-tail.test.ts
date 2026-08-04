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
    expect(buffer.getLine(buffer.cursorY)?.getCell(buffer.cursorX)?.getChars()).toBe('다')

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')

    // The overlay xterm paints still hides 다; the tail restores it past the preedit.
    expect(compositionView.textContent).not.toContain('다')
    const tail = tailOf(container)
    expect(tail.textContent).toBe('다라마')
    expect(tail.style.display).toBe('block')
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
    const { compositionView, container, screenElement, terminal, textarea } = openTerminal()
    // 40 cols over 400px keeps the cell grid at a round 10px.
    vi.spyOn(screenElement, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 120
    } as DOMRect)
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')
    compositionEvent(textarea, 'compositionupdate', '바')

    const preeditLeft = Number.parseFloat(compositionView.style.left || '0')
    // 바 budgets two cells, so the tail resumes exactly two cells later.
    expect(tailOf(container).style.left).toBe(`${preeditLeft + 20}px`)
  })

  it('advances each repainted character on the cell grid, not on font metrics', async () => {
    const { container, screenElement, terminal, textarea } = openTerminal()
    vi.spyOn(screenElement, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 120
    } as DOMRect)
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

  it('rejects a see-through theme background that would double-expose the cells', async () => {
    const { container, terminal, textarea } = openTerminal({ background: 'rgba(20, 20, 20, 0.5)' })
    await write(terminal, '가나다라마')
    await write(terminal, CURSOR_BACK_3_SYLLABLES)

    compositionEvent(textarea, 'compositionstart')

    expect(tailOf(container).style.backgroundColor).not.toContain('0.5')
  })

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
