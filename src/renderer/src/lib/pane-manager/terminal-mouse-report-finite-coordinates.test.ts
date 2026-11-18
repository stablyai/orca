// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'

// #20983: xterm's touch inertia events carry no clientX/clientY, so their report
// coordinates are NaN; the patched range check must refuse them.

type TriggerMouseEvent = (event: {
  col: number
  row: number
  x: number
  y: number
  button: number
  action: number
  ctrl: boolean
  alt: boolean
  shift: boolean
}) => boolean

type TerminalWithMouseService = {
  _core?: { _mouseService?: { _triggerMouseEvent?: TriggerMouseEvent } }
}

function readTriggerMouseEvent(terminal: Terminal): TriggerMouseEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm keeps MouseService private; missing members are checked below.
  const mouseService = (terminal as unknown as TerminalWithMouseService)._core?._mouseService
  const trigger = mouseService?._triggerMouseEvent
  if (!mouseService || typeof trigger !== 'function') {
    throw new Error('xterm mouse internals are unavailable')
  }
  return (event) => trigger.call(mouseService, event)
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('refuses wheel reports with NaN coordinates and still encodes in-range ones', async () => {
  // Why: happy-dom has no 2D canvas; xterm's DOM renderer only needs glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's WidthCache only calls measureText on this context.
    { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  try {
    terminal.open(container)
    const emitted: string[] = []
    terminal.onData((data) => emitted.push(data))
    await new Promise<void>((resolve) => terminal.write('\x1b[?1000h\x1b[?1006h', resolve))
    const trigger = readTriggerMouseEvent(terminal)
    const wheelDown = { x: 0, y: 0, button: 4, action: 1, ctrl: false, alt: false, shift: false }

    expect(trigger({ ...wheelDown, col: Number.NaN, row: Number.NaN })).toBe(false)
    expect(trigger({ ...wheelDown, col: 3, row: Number.NaN })).toBe(false)
    expect(trigger({ ...wheelDown, col: 3, row: 4 })).toBe(true)
    expect(emitted).toEqual(['\x1b[<65;4;5M'])
  } finally {
    terminal.dispose()
  }
})
