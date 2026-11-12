import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { wakeAnchoredRow, wakeAnchorText } from './cloud-wake-scroll-anchor'

/** A real terminal holding `rows`, one per line, with room for all of them. */
async function terminalWith(rows: string[]): Promise<Terminal> {
  const terminal = new Terminal({ cols: 20, rows: 4, scrollback: 100, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(rows.join('\r\n'), resolve))
  return terminal
}

// REG-13: the line a person scrolled to during a wake is found again by its text, nearest its old row.
describe('wake scroll anchor', () => {
  it('reads a row without trailing blanks, and null for an empty or unreadable one', async () => {
    const terminal = await terminalWith(['ok   ', '', 'next'])
    const active = terminal.buffer.active
    expect(wakeAnchorText(active, 0)).toBe('ok')
    expect(wakeAnchorText(active, 1)).toBeNull()
    expect(wakeAnchorText({}, 0)).toBeNull()
  })

  it('picks the occurrence nearest the old row when the line repeats (repeated log lines)', async () => {
    const terminal = await terminalWith(['tick', 'a', 'b', 'tick', 'c', 'd', 'e', 'f', 'tick', 'g'])
    const active = terminal.buffer.active
    expect(wakeAnchoredRow(active, 'tick', 6)).toBe(8)
    expect(wakeAnchoredRow(active, 'tick', 4)).toBe(3)
    expect(wakeAnchoredRow(active, 'tick', 1)).toBe(0)
  })

  it('keeps the old row when the line is gone, or when nothing was anchored', async () => {
    const terminal = await terminalWith(['a', 'b', 'c'])
    const active = terminal.buffer.active
    expect(wakeAnchoredRow(active, 'missing', 1)).toBe(1)
    expect(wakeAnchoredRow(active, null, 2)).toBe(2)
  })
})
