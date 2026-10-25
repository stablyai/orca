import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForTerminalReplayWritesParsed } from '@/components/terminal-pane/replay-guard'
import { waitForTerminalOutputParsed } from './pane-terminal-output-scheduler'
import {
  _resetWritePipelineHealthForTests,
  captureTerminalParseProgressGeneration,
  isTerminalWritePipelineCertifiedDead,
  requestTerminalWritePipelineProbe
} from './terminal-write-pipeline-health'
import { writeXtermParseBarrier } from './xterm-parse-barrier'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

type Terminal = HeadlessTerminal | BrowserTerminal
const terminals: Terminal[] = []

function createTerminal(Constructor: typeof HeadlessTerminal | typeof BrowserTerminal): Terminal {
  const terminal = new Constructor({ cols: 80, rows: 24, allowProposedApi: true })
  terminals.push(terminal)
  return terminal
}

function line(terminal: Terminal, row: number): string | undefined {
  return terminal.buffer.active.getLine(row)?.translateToString(true)
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    _resetWritePipelineHealthForTests(terminal)
    terminal.dispose()
  }
  vi.useRealTimers()
})

describe.each([
  ['headless', HeadlessTerminal],
  ['browser', BrowserTerminal]
] as const)('%s xterm parse barrier across a resize', (_name, Constructor) => {
  it('fires its callback and keeps the writes queued behind it', () => {
    const terminal = createTerminal(Constructor)
    const parsed: string[] = []
    terminal.write('before\r\n', () => parsed.push('before'))
    writeXtermParseBarrier(terminal, () => parsed.push('barrier'))
    terminal.write('after\r\n', () => parsed.push('after'))
    terminal.resize(40, 10)
    expect(parsed).toEqual(['before', 'barrier', 'after'])
    expect([line(terminal, 0), line(terminal, 1)]).toEqual(['before', 'after'])
  })

  it('lets a replay wait settle without falling back to its stall probe', async () => {
    vi.useFakeTimers()
    const terminal = createTerminal(Constructor)
    let settled = false
    terminal.write('replayed\r\n')
    const waiting = waitForTerminalReplayWritesParsed(terminal, { stallCheckMs: 60_000 }).then(
      () => {
        settled = true
      }
    )
    terminal.write('live\r\n')
    terminal.resize(40, 10)
    await Promise.resolve()
    expect(settled).toBe(true)
    expect([line(terminal, 0), line(terminal, 1)]).toEqual(['replayed', 'live'])
    await waiting
  })

  it('settles the output scheduler wait before its fallback timer', async () => {
    vi.useFakeTimers()
    const terminal = createTerminal(Constructor)
    let settled = false
    terminal.write('before\r\n')
    const waiting = waitForTerminalOutputParsed(terminal).then(() => {
      settled = true
    })
    terminal.write('after\r\n')
    terminal.resize(40, 10)
    await Promise.resolve()
    expect(settled).toBe(true)
    expect([line(terminal, 0), line(terminal, 1)]).toEqual(['before', 'after'])
    await waiting
  })

  it('keeps a resized live terminal healthy after the probe deadline', () => {
    vi.useFakeTimers()
    const terminal = createTerminal(Constructor)
    requestTerminalWritePipelineProbe(terminal, { stallCheckMs: 10 })
    vi.advanceTimersByTime(10)
    terminal.write('after\r\n')
    terminal.resize(40, 10)
    vi.advanceTimersByTime(10)
    expect({
      line: line(terminal, 0),
      progressed: captureTerminalParseProgressGeneration(terminal) > 0,
      dead: isTerminalWritePipelineCertifiedDead(terminal)
    }).toEqual({ line: 'after', progressed: true, dead: false })
  })

  it('preserves partial UTF-8 and escape sequences without writing marker bytes', () => {
    const terminal = createTerminal(Constructor)
    terminal.write(new Uint8Array([0xe2]))
    writeXtermParseBarrier(terminal, () => {})
    terminal.write(new Uint8Array([0x82, 0xac]))
    terminal.write('\x1b[3')
    writeXtermParseBarrier(terminal, () => {})
    terminal.write('1mred')
    terminal.resize(40, 10)
    expect(line(terminal, 0)).toBe('€red')
  })

  it('completes repeated barriers without a resize and permits subsequent writes', async () => {
    const terminal = createTerminal(Constructor)
    const parsed: number[] = []
    terminal.write('before')
    for (let i = 0; i < 100; i += 1) {
      writeXtermParseBarrier(terminal, () => parsed.push(i))
    }
    await new Promise<void>((resolve) => terminal.write('after', resolve))
    expect(parsed).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(line(terminal, 0)).toBe('beforeafter')
    terminal.write('future')
    terminal.resize(40, 10)
    expect(line(terminal, 0)).toBe('beforeafterfuture')
  })
})
