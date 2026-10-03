// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercises the vendored xterm patch for #20983: a detached screen element has
// no computed padding, so report coordinates became NaN and were encoded into
// the PTY as "\x1b[<65;NaN;NaNM".

const terminals: Terminal[] = []

function openTerminal(): { emitted: string[]; terminal: Terminal } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  terminals.push(terminal)
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  // SGR mouse encoding with wheel reporting.
  terminal.write('\x1b[?1000h\x1b[?1006h')
  return { emitted, terminal }
}

type MouseReportEvent = {
  col: number
  row: number
  x: number
  y: number
  button: number
  action: number
  ctrl: boolean
  alt: boolean
  shift: boolean
}

type MouseCoordsElement = {
  getBoundingClientRect: () => { left: number; top: number }
  ownerDocument: {
    defaultView: { getComputedStyle: () => { getPropertyValue: () => string } }
  }
}

/** The private xterm core services these tests drive directly. */
type XtermMouseCore = {
  _mouseService: { _triggerMouseEvent: (event: MouseReportEvent) => boolean }
  _charSizeService: Record<string, unknown>
  _mouseCoordsService: {
    getMouseReportCoords: (
      event: { clientX: number; clientY: number },
      element: MouseCoordsElement
    ) => unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isXtermMouseCore(value: unknown): value is XtermMouseCore {
  if (!isRecord(value)) {
    return false
  }
  const { _mouseService: mouse, _charSizeService: charSize, _mouseCoordsService: coords } = value
  return (
    isRecord(mouse) &&
    typeof mouse._triggerMouseEvent === 'function' &&
    isRecord(charSize) &&
    isRecord(coords) &&
    typeof coords.getMouseReportCoords === 'function'
  )
}

function readMouseCore(terminal: Terminal): XtermMouseCore {
  const core: unknown = '_core' in terminal ? terminal._core : undefined
  if (!isXtermMouseCore(core)) {
    throw new Error('xterm mouse internals are unavailable')
  }
  return core
}

function triggerMouseReport(terminal: Terminal, col: number, row: number): boolean {
  return Boolean(
    readMouseCore(terminal)._mouseService._triggerMouseEvent({
      col,
      row,
      x: 0,
      y: 0,
      button: 4,
      action: 1,
      ctrl: false,
      alt: false,
      shift: false
    })
  )
}

function flushWrites(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => terminal.write('', resolve))
}

beforeEach(() => {
  // Why: happy-dom has no 2D canvas; xterm's DOM renderer only needs glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's WidthCache only calls measureText on this context.
    { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
  )
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('xterm mouse report coordinates', () => {
  it('refuses to encode a report with NaN coordinates', async () => {
    const { emitted, terminal } = openTerminal()
    await flushWrites(terminal)

    expect(triggerMouseReport(terminal, Number.NaN, Number.NaN)).toBe(false)
    expect(triggerMouseReport(terminal, 3, Number.NaN)).toBe(false)
    expect(emitted.join('')).not.toContain('NaN')
  })

  it('still encodes an in-range wheel report', async () => {
    const { emitted, terminal } = openTerminal()
    await flushWrites(terminal)

    expect(triggerMouseReport(terminal, 3, 4)).toBe(true)
    expect(emitted).toContain('\x1b[<65;4;5M')
  })

  it('yields no report coordinates for an element without computed padding', () => {
    const { terminal } = openTerminal()
    const core = readMouseCore(terminal)
    // Why: happy-dom cannot measure glyphs; give the service a valid cell size.
    Object.defineProperty(core._charSizeService, 'hasValidSize', {
      configurable: true,
      value: true
    })
    const detachedLike: MouseCoordsElement = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) }
      }
    }

    expect(
      core._mouseCoordsService.getMouseReportCoords({ clientX: 10, clientY: 10 }, detachedLike)
    ).toBeUndefined()
  })
})
