import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForTerminalReplayWritesParsed } from '@/components/terminal-pane/replay-guard'
import { writeXtermParseBarrier } from './xterm-parse-barrier'

const terminals: Terminal[] = []

function headlessTerminal(): Terminal {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  terminals.push(terminal)
  return terminal
}

function line(terminal: Terminal, row: number): string | undefined {
  return terminal.buffer.active.getLine(row)?.translateToString(true)
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
})

// A resize flushes xterm's write queue synchronously; a barrier queued at that moment must
// still complete, and the output queued behind it must still parse.
describe('xterm parse barrier across a resize', () => {
  it('fires its callback and keeps the writes queued behind it', () => {
    const terminal = headlessTerminal()
    let parsed = false
    terminal.write('before\r\n')
    writeXtermParseBarrier(terminal, () => {
      parsed = true
    })
    terminal.write('after\r\n')
    terminal.resize(40, 10)
    expect(parsed).toBe(true)
    expect([line(terminal, 0), line(terminal, 1)]).toEqual(['before', 'after'])
  })

  it('lets a replay wait settle without falling back to its stall probe', async () => {
    const terminal = headlessTerminal()
    let settled = false
    terminal.write('replayed\r\n')
    const waiting = waitForTerminalReplayWritesParsed(terminal, { stallCheckMs: 60_000 }).then(
      () => {
        settled = true
      }
    )
    terminal.write('live\r\n')
    terminal.resize(40, 10)
    await Promise.race([waiting, new Promise((resolve) => setTimeout(resolve, 50))])
    expect(settled).toBe(true)
    expect([line(terminal, 0), line(terminal, 1)]).toEqual(['replayed', 'live'])
  })
})
