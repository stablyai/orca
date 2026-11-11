import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetWritePipelineHealthForTests } from './terminal-write-pipeline-health'
import { writeXtermParseBarrier } from './xterm-parse-barrier'

vi.mock('@/app-shell/startup/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

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
})
