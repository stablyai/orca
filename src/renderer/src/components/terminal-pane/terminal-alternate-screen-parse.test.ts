import { describe, expect, it } from 'vitest'
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
