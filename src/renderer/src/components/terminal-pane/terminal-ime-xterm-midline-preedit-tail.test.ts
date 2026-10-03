// @vitest-environment happy-dom
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
  withCandidateAnchor?: boolean
}

function stubCompositionLayout(preeditWidth: () => number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('xterm-composition-preedit')) {
      return DOMRect.fromRect({ height: CELL_HEIGHT_PX, width: preeditWidth() })
    }
    if (this.classList.contains('xterm-screen')) {
      return DOMRect.fromRect({ height: 24 * CELL_HEIGHT_PX, width: 80 * CELL_WIDTH_PX })
    }
    return DOMRect.fromRect({ height: 0, width: 0 })
  })
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

describe('composition overlays the grid without copying the row tail', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(async () => {
    await nextEventLoop()
    await nextEventLoop()
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('leaves committed text in the buffer while composing over its first cells', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret])
    expect(rig.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('안녕하세요')
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(preedit!.style.textDecoration).toBe('underline')
    expect(remainder).toBeNull()
    expect(rig.compositionView.style.direction).toBe('ltr')
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
    const cursorX = rig.terminal.buffer.active.cursorX
    const sent: string[] = []
    const subscription = rig.terminal.onData((data) => sent.push(data))
    rig.textarea.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, code: 'Escape', key: 'Escape' })
    )
    await nextEventLoop()
    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.children).toHaveLength(0)
    expect(rig.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('안녕하세요')
    expect(rig.terminal.buffer.active.cursorX).toBe(cursorX)
    expect(sent).toEqual([])
    subscription.dispose()
  })

  it('does not copy the tail as the preedit grows', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')

    rig.composeStart()
    rig.composeUpdate('ㄱ')
    rig.composeUpdate('가')
    rig.composeUpdate('강')

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret])
    expect(stripMarks(preedit!.textContent)).toBe('강')
    expect(remainder).toBeNull()
  })

  it('does not copy a padded row or its border into the preedit', async () => {
    const rig = openTerminal()
    await rig.write('> hi          |\x1b[13D')

    rig.compose('가')

    const { remainder } = viewParts(rig.compositionView)
    expect(remainder).toBeNull()
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

  it('keeps the caret and IME candidate anchor visible over committed text in the final cell', async () => {
    const rig = openTerminal({ cursorWidth: 2, withCandidateAnchor: true })
    await rig.write('x'.repeat(80))
    let preeditWidth = CELL_WIDTH_PX * 2
    stubCompositionLayout(() => preeditWidth)

    rig.compose('가')

    const { caret, remainder } = viewParts(rig.compositionView)
    expect(rig.terminal.buffer.active.cursorX).toBe(80)
    expect(remainder).toBeNull()
    expect(rig.compositionView.style.maxWidth).toBe(`${CELL_WIDTH_PX}px`)
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
    expect(caret!.style.width).toBe('2px')
    expect(rig.textarea.style.left).toBe(`${rig.terminal.cols * CELL_WIDTH_PX - preeditWidth}px`)
    expect(rig.textarea.style.width).toBe(`${preeditWidth}px`)

    preeditWidth = CELL_WIDTH_PX / 2
    await rig.writeAwaitingRender('\x1b[0m')
    expect(remainder).toBeNull()
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
    expect(rig.textarea.style.left).toBe(`${(rig.terminal.cols - 1) * CELL_WIDTH_PX}px`)
    expect(rig.textarea.style.width).toBe(`${preeditWidth}px`)
  })

  it('keeps the candidate anchor inside the screen across a render, not just a composition event', async () => {
    const rig = openTerminal({ cursorWidth: 2, withCandidateAnchor: true })
    await rig.write('x'.repeat(80))
    stubCompositionLayout(() => CELL_WIDTH_PX * 2)

    rig.compose('가')
    const clamped = `${rig.terminal.cols * CELL_WIDTH_PX - CELL_WIDTH_PX * 2}px`
    expect(rig.textarea.style.left).toBe(clamped)

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

  it('does not reproduce arbitrary dimmed output at column zero', async () => {
    const rig = openTerminal()
    const dimmedRow = 'Waiting for input'
    await rig.write(`\x1b[2m${dimmedRow}\x1b[22m\x1b[${dimmedRow.length}D`)

    rig.compose('아')

    const { caret, preedit, remainder } = viewParts(rig.compositionView)
    expect(Array.from(rig.compositionView.children)).toEqual([preedit, caret])
    expect(stripMarks(preedit!.textContent)).toBe('아')
    expect(remainder).toBeNull()
  })

  it('does not reproduce a wholly dim mid-line tail', async () => {
    const rig = openTerminal()
    const tail = 'status'
    await rig.write(`> \x1b[2m${tail}\x1b[22m\x1b[${tail.length}D`)

    expect(rig.terminal.buffer.active.cursorX).toBe(2)
    rig.compose('아')

    const { remainder } = viewParts(rig.compositionView)
    expect(remainder).toBeNull()
  })

  it('does not reproduce a mixed dim and committed tail', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[2mghost\x1b[22m!\x1b[6D')

    rig.compose('아')

    const { remainder } = viewParts(rig.compositionView)
    expect(remainder).toBeNull()
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
    const rig = openTerminal({
      theme: { background: 'rgba(17, 34, 51, 0.6)', foreground: '#aabbcc' }
    })
    await rig.write('안녕하세요\x1b[6D')

    rig.compose('가')

    expect(['#112233', 'rgb(17, 34, 51)']).toContain(rig.compositionView.style.background)
    expect(rig.compositionView.style.background).not.toMatch(/^rgba/i)
  })

  it('keeps preedit nodes stable when the underlying row repaints', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')
    rig.compose('가')
    const original = viewParts(rig.compositionView)
    const glyphs = Array.from(original.preedit!.childNodes)

    await rig.writeAwaitingRender('\x1b[K체크\x1b[4D')

    const { preedit, remainder } = viewParts(rig.compositionView)
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(remainder).toBeNull()
    expect(preedit).toBe(original.preedit)
    expect(Array.from(preedit!.childNodes)).toEqual(glyphs)
    expect(viewParts(rig.compositionView).caret).toBe(original.caret)

    await rig.writeAwaitingRender('\x1b[K')
    expect(viewParts(rig.compositionView).remainder).toBeNull()
    expect(viewParts(rig.compositionView).preedit).toBe(original.preedit)
  })

  it('does not copy streamed output into an open composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕')
    rig.compose('가')
    expect(viewParts(rig.compositionView).remainder).toBeNull()

    await rig.writeAwaitingRender('하세요\x1b[6D')

    const { preedit, remainder } = viewParts(rig.compositionView)
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(remainder).toBeNull()
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
  it.each([
    ['truecolor', '\x1b[48;2;70;80;90m', '#46505a'],
    ['indexed', '\x1b[48;5;240m', '#585858'],
    ['inverse truecolor', '\x1b[38;2;70;80;90;7m', '#46505a'],
    ['inverse default', '\x1b[7m', '#aabbcc']
  ])('uses the cursor cell background for %s', async (_name, attributes, expected) => {
    const rig = openTerminal()
    await rig.write(`${attributes}placeholder\x1b[0m\x1b[11D`)
    rig.compose('ni')
    expect(rig.compositionView.style.background).toBe(expected)
    expect(rig.compositionView.style.color).not.toBe(rig.compositionView.style.background)
    expect(rig.compositionView.style.width).toBe('max-content')
    expect(stripMarks(rig.compositionView.textContent)).toBe('ni')
    expect(rig.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('placeholder')
  })

  it('tracks a repainted cell background without touching the preedit or dim tail', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[2;48;2;70;80;90mplaceholder\x1b[0m\x1b[11D')
    rig.compose('ni')
    const preedit = viewParts(rig.compositionView).preedit
    await rig.writeAwaitingRender('\x1b[2;48;2;90;80;70mplaceholder\x1b[0m\x1b[11D')
    expect(rig.compositionView.style.background).toBe('#5a5046')
    expect(viewParts(rig.compositionView).preedit).toBe(preedit)
    expect(rig.terminal.buffer.active.getLine(0)?.getCell(4)?.isDim()).toBeTruthy()
    expect(stripMarks(rig.compositionView.textContent)).toBe('ni')
  })
  it('sends only the confirmed Chinese character once and clears the overlay', async () => {
    const rig = openTerminal()
    await rig.write('\x1b[2mAsk Codex to do anything\x1b[0m\x1b[23D')
    const input = vi.fn()
    rig.terminal.onData(input)
    rig.compose('ni')
    expect(input).not.toHaveBeenCalled()
    expect(stripMarks(rig.compositionView.textContent)).toBe('ni')
    rig.textarea.value = '你'
    rig.textarea.dispatchEvent(
      new CompositionEvent('compositionend', { data: '你', bubbles: true })
    )
    await nextEventLoop()
    await nextEventLoop()
    expect(input).toHaveBeenCalledExactlyOnceWith('你')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      'Ask Codex to do anything'
    )
  })
})
