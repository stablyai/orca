// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'

// #10861/#18865: a selection forced with Option-drag over a mouse-reporting TUI must survive
// the reports xterm forwards afterwards, or Cmd+C and right-click Copy find nothing to copy.

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

async function openMouseReportingTerminal(): Promise<{ terminal: Terminal; emitted: string[] }> {
  // Why: happy-dom has no 2D canvas; xterm's DOM renderer only needs glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's WidthCache only calls measureText on this context.
    { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  await new Promise<void>((resolve) => terminal.write('\x1b[?1000h\x1b[?1006hhello world', resolve))
  return { terminal, emitted }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('keeps the selection while SGR wheel and button reports reach the TUI', async () => {
  const { terminal, emitted } = await openMouseReportingTerminal()
  try {
    const trigger = readTriggerMouseEvent(terminal)
    terminal.select(0, 0, 11)
    const at = { col: 3, row: 4, x: 0, y: 0, ctrl: false, alt: false, shift: false }

    expect(trigger({ ...at, button: 4, action: 1 })).toBe(true)
    expect(trigger({ ...at, button: 2, action: 1 })).toBe(true)
    expect(trigger({ ...at, button: 2, action: 0 })).toBe(true)

    expect(emitted).toEqual(['\x1b[<65;4;5M', '\x1b[<2;4;5M', '\x1b[<2;4;5m'])
    expect(terminal.getSelection()).toBe('hello world')
  } finally {
    terminal.dispose()
  }
})

it('clears the selection on a reported left press, like typing', async () => {
  const { terminal, emitted } = await openMouseReportingTerminal()
  try {
    const trigger = readTriggerMouseEvent(terminal)
    terminal.select(0, 0, 11)

    expect(
      trigger({
        col: 3,
        row: 4,
        x: 0,
        y: 0,
        ctrl: false,
        alt: false,
        shift: false,
        button: 0,
        action: 1
      })
    ).toBe(true)

    expect(emitted).toEqual(['\x1b[<0;4;5M'])
    expect(terminal.hasSelection()).toBe(false)
  } finally {
    terminal.dispose()
  }
})

it('still clears the selection on typed input', async () => {
  const { terminal, emitted } = await openMouseReportingTerminal()
  try {
    terminal.select(0, 0, 11)
    terminal.input('x')

    expect(emitted).toEqual(['x'])
    expect(terminal.hasSelection()).toBe(false)
  } finally {
    terminal.dispose()
  }
})
