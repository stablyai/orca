import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { keepDeeperHistoryAfterReplay, mergeDeeperHistory } from './cloud-replay-depth-guard'
import { noteBeforeCloudReplay, resetWakeScrollbackForTests } from './cloud-wake-scrollback'

afterEach(() => {
  resetWakeScrollbackForTests()
})

const PTY = 'remote:env@@term-1'
const lines = (from: number, to: number): string[] => {
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    out.push(`\x1b[3${n % 8}m${String(n).padStart(5, '0')}\x1b[0m line`)
  }
  return out
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function rows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.normal
  const out: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    out.push(buffer.getLine(y)!.translateToString(true).trimEnd())
  }
  while (out.length > 0 && out.at(-1) === '') {
    out.pop()
  }
  return out
}

/** What the drain does: keep the pane's copy, the replay (it clears), then the guard. */
async function shallowReplay(terminal: Terminal, replay: string): Promise<boolean> {
  await noteBeforeCloudReplay('leaf', terminal, PTY, () => true)
  await write(terminal, `\x1b[2J\x1b[3J\x1b[H${replay}`)
  return keepDeeperHistoryAfterReplay('leaf', terminal, PTY, (data) => write(terminal, data))
}

describe('a shallower replay never shrinks a cloud pane (N-02)', () => {
  it('a full snapshot followed by a 1000-row replay keeps all 5000 rows', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 6000, allowProposedApi: true })
    await write(terminal, `${lines(1, 5000).join('\r\n')}\r\n$ `)
    expect(rows(terminal)[0]).toBe('00001 line')

    const kept = await shallowReplay(terminal, `${lines(4001, 5000).join('\r\n')}\r\n$ `)

    expect(kept).toBe(true)
    const after = rows(terminal)
    expect(after[0]).toBe('00001 line')
    expect(after.filter((row) => row.endsWith(' line'))).toHaveLength(5000)
    expect(after.at(-1)).toBe('$')
  })

  it('a 4th reveal in a minute (rebuild capped at 1000 rows) still shows all 5000 from line 1', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 6000, allowProposedApi: true })
    await write(terminal, `${lines(1, 5000).join('\r\n')}\r\n$ `)
    // The pane missed output while hidden: the host's capped image carries the new lines too.
    const rebuilt = [...lines(4021, 5000), ...lines(5001, 5020)]

    const kept = await shallowReplay(terminal, `${rebuilt.join('\r\n')}\r\n$ `)

    expect(kept).toBe(true)
    const after = rows(terminal)
    expect(after[0]).toBe('00001 line')
    expect(after.filter((row) => row.endsWith(' line'))).toHaveLength(5020)
    expect(after.filter((row) => row === '05000 line')).toHaveLength(1)
  })

  // V3-02: asleep, woken, then the app restarted. Everything above the divider lived only in this
  // pane; the host's (new) terminal has just what came after the wake.
  it('keeps the output from before a sleep when the host replay after a restart has none of it', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 6000, allowProposedApi: true })
    const divider = '── Slept 10:46–10:52 AM · processes stopped ──'
    const postWake = ['$ seq 5001 5003', '5001', '5002', '5003', 'N02W-POSTWAKE']
    await write(terminal, `${[...lines(1, 300), divider, ...postWake].join('\r\n')}\r\n$ `)

    const kept = await shallowReplay(terminal, `${postWake.join('\r\n')}\r\n$ `)

    expect(kept).toBe(true)
    const after = rows(terminal)
    expect(after[0]).toBe('00001 line')
    expect(after).toContain(divider)
    expect(after.filter((row) => row === 'N02W-POSTWAKE')).toHaveLength(1)
    expect(after.indexOf(divider)).toBeLessThan(after.indexOf('5001'))
  })

  it('keeps the output from before a sleep when the restarted host shows only a fresh prompt', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 6000, allowProposedApi: true })
    const divider = '── Slept 10:46–10:52 AM · processes stopped ──'
    await write(terminal, `${[...lines(1, 40), divider].join('\r\n')}\r\n$ `)

    const kept = await shallowReplay(terminal, '$ ')

    expect(kept).toBe(true)
    const after = rows(terminal)
    expect(after[0]).toBe('00001 line')
    expect(after.at(-2)).toBe(divider)
    expect(after.at(-1)).toBe('$')
  })

  it('two sleeps before the restart: keeps everything up to the last divider, nothing doubled', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 6000, allowProposedApi: true })
    const first = '── Slept 9:00–9:30 AM · processes stopped ──'
    const second = '── Slept 10:46–10:52 AM · processes stopped ──'
    const postWake = ['$ echo after-second', 'after-second']
    await write(
      terminal,
      `${[...lines(1, 50), first, ...lines(51, 80), second, ...postWake].join('\r\n')}\r\n$ `
    )

    const kept = await shallowReplay(terminal, `${postWake.join('\r\n')}\r\n$ `)

    expect(kept).toBe(true)
    const after = rows(terminal)
    expect(after[0]).toBe('00001 line')
    expect(after.filter((row) => row === first)).toHaveLength(1)
    expect(after.filter((row) => row === second)).toHaveLength(1)
    expect(after.filter((row) => row === '00080 line')).toHaveLength(1)
    expect(after.filter((row) => row === 'after-second')).toHaveLength(1)
    expect(after.indexOf(first)).toBeLessThan(after.indexOf(second))
  })

  it('leaves the replay alone when it does not overlap what the pane held', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 6000, allowProposedApi: true })
    await write(terminal, `${lines(1, 3000).join('\r\n')}\r\n$ `)

    const kept = await shallowReplay(terminal, `${lines(7001, 8000).join('\r\n')}\r\n$ `)

    expect(kept).toBe(false)
    expect(rows(terminal)[0]).toBe('07001 line')
  })

  it('merges at the overlap and never repeats lines', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\r\n')
    expect(mergeDeeperHistory(before, ['tail-of-d', 'e', 'f', 'g'].join('\r\n'))).toBe(before)
    expect(mergeDeeperHistory(before, ['x', 'y', 'z', 'w'].join('\r\n'))).toBeNull()
    expect(
      mergeDeeperHistory(['a', 'b'].join('\r\n'), ['a', 'b', 'c', 'd'].join('\r\n'))
    ).toBeNull()
  })
})
