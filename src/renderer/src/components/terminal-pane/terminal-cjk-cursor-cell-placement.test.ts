// @vitest-environment happy-dom
/**
 * Issue #12729 — "the cursor lands on the wide character's first cell and clips its right half".
 *
 * The report pins two claims about the cursor. Both are pinned here against the vendored xterm,
 * because neither reproduces and a regression in either would change what the answer to that
 * issue is:
 *
 *   1. the reporter's captured pty stream must leave the cursor on the column the application
 *      asked for (`CSI 25;11H`), not on the last syllable's starting cell; and
 *   2. a block cursor sitting on a full-width glyph must carry the whole syllable, so nothing
 *      about the cursor can hide half a character.
 *
 * The occluding box in that report is the IME preedit overlay, not the cursor — see
 * `terminal-ime-xterm-trailing-preedit-occlusion.test.ts`.
 *
 * Claim 2 is pinned against the DOM renderer, which is the only one happy-dom can drive. The
 * shipped default on macOS is webgl, where the same guarantee comes from a different mechanism —
 * the cursor fill spans `cursorX .. cursorX + cell.getWidth() - 1`, so it covers both cells of a
 * wide glyph rather than clipping one. That arm cannot live here.
 */
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

/**
 * Lets the write settle, drains the frame it already scheduled, then subscribes before forcing the
 * one under assertion — so the row spans read below are the rendered ones, and the listener is
 * always in place before its trigger rather than racing a frame that already fired.
 */
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
    // The whole syllable is inside the cursor span, so a block cursor cannot clip its right half.
    expect(cursorSpan?.textContent).toBe('라')
    expect(cursorSpan?.classList.contains('xterm-cursor-block')).toBe(true)
  })
})
