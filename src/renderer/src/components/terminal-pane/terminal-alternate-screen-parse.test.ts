import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'

function writeChunk(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

// Pins the xterm contract the alternate-screen atlas recovery relies on: by the
// time a chunk's write callback runs, buffer.active.type reflects any
// alternate-screen enter/exit parsed from that chunk — even when the sequence
// splits across PTY chunk boundaries.
describe('alternate-screen buffer state at write-callback time', () => {
  it('reflects an enter sequence split across two chunks', async () => {
    const term = new Terminal({ cols: 120, rows: 34, allowProposedApi: true })
    await writeChunk(term, '\x1b[?104')
    expect(term.buffer.active.type).toBe('normal')
    await writeChunk(term, '9h\x1b[2J\x1b[H~\x1b[K')
    expect(term.buffer.active.type).toBe('alternate')
    term.dispose()
  })

  it('fires onBufferChange for each switch when one chunk enters and exits', async () => {
    const term = new Terminal({ cols: 120, rows: 34, allowProposedApi: true })
    let switches = 0
    const disposable = term.buffer.onBufferChange(() => {
      switches += 1
    })
    await writeChunk(term, '\x1b[?1049h\x1b[2J\x1b[Hpager frame\x1b[K\x1b[?1049l')
    expect(term.buffer.active.type).toBe('normal')
    expect(switches).toBe(2)
    disposable.dispose()
    term.dispose()
  })

  it('tracks enter, split redraw, and exit from a real captured vim session', async () => {
    const term = new Terminal({ cols: 120, rows: 34, allowProposedApi: true })
    // Captured from `vim package.json` (macOS, TERM=xterm-256color): startup chunk.
    await writeChunk(
      term,
      '\x1b[?1049h\x1b[>4;2m\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[1;34r\x1b[?12h\x1b[?12l\x1b[22;2t\x1b[22;1t'
    )
    expect(term.buffer.active.type).toBe('alternate')
    // Mid-session redraw where a 1024-byte PTY read split \x1b[30;5H in two.
    await writeChunk(term, '"rules": {\x1b[29;15H\x1b[K\x1b[30')
    await writeChunk(
      term,
      ';5H  "js-combine-iterations": "off"\r\n    }\x1b[31;6H\x1b[K\x1b[33;1H\x1b[?25h'
    )
    expect(term.buffer.active.type).toBe('alternate')
    // Vim quit: erase the status line and restore the normal buffer in one chunk.
    await writeChunk(
      term,
      '\x1b[23;2t\x1b[23;1t\x1b[34;1H\x1b[K\x1b[34;1H\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[?1049l\x1b[?25h\x1b[>4;m'
    )
    expect(term.buffer.active.type).toBe('normal')
    term.dispose()
  })
})

/**
 * Repro for the frozen-terminal investigation (Discord #performance / #2836).
 *
 * The vendored xterm WriteBuffer (6.1.0-beta.287) permanently wedges when a
 * synchronous exception escapes a write-completion callback: `_innerWrite`
 * has no try/catch around `cb()`, the tail `_scheduleInnerWrite()` never
 * runs, and later `write()` calls only re-schedule processing when the
 * buffer is EMPTY — which a stalled buffer never is again.
 *
 * In Orca, write-completion callbacks run settleForegroundRender → refresh →
 * renderer/WebGL code (pane-terminal-foreground-render-settle.ts) and the
 * replay-guard decrement (replay-guard.ts). So one renderer exception during
 * write completion freezes that pane's output forever AND latches the replay
 * guard, whose gate in pty-connection.ts onData then silently drops every
 * keystroke — the exact live-shell/flat-output.log/frozen-pane state the
 * field reports describe. @xterm/headless shares the same WriteBuffer as
 * @xterm/xterm at the same pinned version.
 */
describe('xterm WriteBuffer stall (vendored 6.1.0-beta.287)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('permanently stops completing writes after a sync throw in a write-completion callback', () => {
    vi.useFakeTimers()
    const term = new Terminal({ allowProposedApi: true })
    const completed: string[] = []

    term.write('first', () => {
      completed.push('first')
      throw new Error('synthetic renderer failure during write completion')
    })
    term.write('second', () => {
      completed.push('second')
    })

    expect(() => vi.runAllTimers()).toThrow('synthetic renderer failure')

    // The wedge: the stalled buffer is never empty again, so new writes only
    // enqueue — no drain is ever scheduled and no callback ever fires.
    term.write('third', () => {
      completed.push('third')
    })
    vi.runAllTimers()
    expect(completed).toEqual(['first'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('permanently stops completing writes after a sync throw in a custom parser handler', () => {
    // Orca registers custom CSI/OSC handlers (capability replies, titles,
    // agent status). The parser does NOT isolate sync handler exceptions:
    // they escape _action and wedge the buffer exactly like the callback
    // case — custom handlers are a second freeze vector.
    vi.useFakeTimers()
    const term = new Terminal({ allowProposedApi: true })
    const completed: string[] = []
    term.parser.registerCsiHandler({ final: 'z' }, () => {
      throw new Error('synthetic parser handler failure')
    })

    term.write('\x1b[z', () => {
      completed.push('poisoned')
    })
    term.write('after', () => {
      completed.push('after')
    })
    expect(() => vi.runAllTimers()).toThrow('synthetic parser handler failure')

    term.write('later', () => {
      completed.push('later')
    })
    vi.runAllTimers()
    expect(completed).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
