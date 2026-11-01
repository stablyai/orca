// @vitest-environment happy-dom
/** Verify reported CUP placement and full-width cursor coverage against vendored xterm (#12729); IME occlusion is tested separately. This exercises DOM only; WebGL covers wide cells through a different fill path. */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Escapes made visible in the issue: hide cursor, home, CUF 2, CUD 24, the text, then two CUPs.
const REPORTED_PTY_STREAM = '\x1b[?25l\x1b[H\x1b[2C\x1b[24B가나다라\x1b[30;1H\x1b[25;11H\x1b[?25h'

type Rig = {
  container: HTMLElement
  terminal: Terminal
}

const openTerminals: Terminal[] = []

function openTerminal(): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 30 })
  terminal.open(container)
  openTerminals.push(terminal)
  return { container, terminal }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

// Drain the pending frame, then subscribe before refresh so assertions observe the forced render.
async function writeAwaitingRender(terminal: Terminal, data: string): Promise<void> {
  await write(terminal, data)
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  const rendered = new Promise<void>((resolve) => {
    const listener = terminal.onRender(() => {
      listener.dispose()
      resolve()
    })
  })
  terminal.refresh(0, terminal.rows - 1)
  await rendered
}

function cursorCell(container: HTMLElement): Element | null {
  return container.querySelector('.xterm-rows .xterm-cursor')
}

function describeCells(terminal: Terminal, count: number): string[] {
  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.cursorY)
  if (!line) {
    throw new Error('cursor row is missing')
  }
  const cells: string[] = []
  for (let x = 0; x < count; x++) {
    const cell = line.getCell(x)
    cells.push(`${cell?.getChars() ?? ''}:${cell?.getWidth() ?? -1}`)
  }
  return cells
}

describe('#12729 — the cursor is not displaced by full-width text', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('leaves the reported pty stream with the cursor on the requested column', async () => {
    const { terminal } = openTerminal()

    await write(terminal, REPORTED_PTY_STREAM)

    const buffer = terminal.buffer.active
    // `CSI 25;11H` is 1-based; the last syllable's starting cell would be 8.
    expect(buffer.cursorX).toBe(10)
    expect(buffer.cursorY).toBe(24)
    // Each syllable owns its cell plus a zero-width continuation, so the run ends at cell 9.
    // Cells 0-1 were never written: the row was reached with CUD, so they stay null.
    expect(describeCells(terminal, 11)).toEqual([
      ':1',
      ':1',
      '가:2',
      ':0',
      '나:2',
      ':0',
      '다:2',
      ':0',
      '라:2',
      ':0',
      ':1'
    ])
  })

  it('paints the cursor after the run, not on the last syllable', async () => {
    const { container, terminal } = openTerminal()
    terminal.focus()

    await writeAwaitingRender(terminal, '> 가나다라')

    const cursorSpan = cursorCell(container)
    expect(cursorSpan?.previousElementSibling?.textContent).toBe('> 가나다라')
    expect(cursorSpan?.textContent).toBe(' ')
  })

  it('carries the whole syllable when the cursor does sit on a full-width glyph', async () => {
    const { container, terminal } = openTerminal()
    terminal.focus()

    // CHA 9: back onto 라's starting cell, the placement the report describes.
    await writeAwaitingRender(terminal, '> 가나다라\x1b[9G')

    expect(terminal.buffer.active.cursorX).toBe(8)
    const cursorSpan = cursorCell(container)
    expect(cursorSpan?.textContent).toBe('라')
    expect(cursorSpan?.classList.contains('xterm-cursor-block')).toBe(true)
  })
})
