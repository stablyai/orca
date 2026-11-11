import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armWakeScrollback,
  beginWakeScrollbackRestore,
  captureWakeScrollback,
  finishWakeScrollbackRestore,
  forgetWakeScrollback,
  resetWakeScrollbackForTests
} from './cloud-wake-scrollback'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_slot: string, name: string) => params?.[name] ?? '')
}))

afterEach(() => resetWakeScrollbackForTests())

const SLEPT_AT = Date.now() - 29 * 60_000
const DIVIDER = /^── Slept .+–.+ · processes stopped ──$/

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function pane(rows = 10): Terminal {
  return new Terminal({ cols: 60, rows, scrollback: 5000, allowProposedApi: true })
}

function text(terminal: Terminal): string[] {
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

function cursorRowText(terminal: Terminal): string {
  const active = terminal.buffer.active
  return active
    .getLine(active.baseY + active.cursorY)!
    .translateToString(true)
    .trimEnd()
}

/** What the drain does with the woken terminal's snapshot: begin, the snapshot (it clears), finish. */
async function wake(terminal: Terminal, leafId: string, newScreen: string): Promise<boolean> {
  const restore = beginWakeScrollbackRestore(leafId, terminal)
  await write(terminal, `\x1b[2J\x1b[3J\x1b[H${newScreen}`)
  if (!restore) {
    return false
  }
  return finishWakeScrollbackRestore(restore, terminal, (data) => write(terminal, data))
}

function capture(terminal: Terminal, leafId: string, agentPane = false): void {
  captureWakeScrollback(leafId, terminal, { sleptAt: SLEPT_AT, agentPane, maxRows: 5000 })
}

describe('WAKE-SCROLLBACK', () => {
  it('a shell pane: `seq 1 2000` above the divider, the woken prompt right below, pinned to the bottom', async () => {
    const terminal = pane()
    const seq = Array.from({ length: 2000 }, (_, index) => String(index + 1)).join('\r\n')
    await write(terminal, `ubuntu@sbx:~$ seq 1 2000\r\n${seq}\r\nubuntu@sbx:~$ sleep 900\r\n`)
    capture(terminal, 'leaf-1')
    armWakeScrollback(['leaf-1'])
    expect(await wake(terminal, 'leaf-1', 'ubuntu@sbx:~$ ')).toBe(true)
    const lines = text(terminal)
    expect(lines[0]).toBe('ubuntu@sbx:~$ seq 1 2000')
    expect(lines[1]).toBe('1')
    expect(lines.at(-3)).toBe('ubuntu@sbx:~$ sleep 900')
    expect(lines.at(-2)).toMatch(DIVIDER)
    expect(lines.at(-1)).toBe('ubuntu@sbx:~$')
    const active = terminal.buffer.active
    expect(active.viewportY).toBe(active.baseY)
    // The cursor is where the woken shell left it: after its prompt.
    expect(cursorRowText(terminal)).toBe('ubuntu@sbx:~$')
    expect(active.cursorX).toBe('ubuntu@sbx:~$ '.length)
  })

  it('a woken screen with rows below the cursor keeps them, and the cursor goes back to its row', async () => {
    const terminal = pane(8)
    await write(terminal, '$ ls\r\nREADME\r\n$ ')
    capture(terminal, 'leaf-1')
    armWakeScrollback(['leaf-1'])
    await wake(terminal, 'leaf-1', '$ \x1b[3;1Hstatus line\x1b[1;3H')
    const lines = text(terminal)
    expect(lines.at(-4)).toMatch(DIVIDER)
    expect(lines.slice(-3)).toEqual(['$', '', 'status line'])
    expect(cursorRowText(terminal)).toBe('$')
    expect(terminal.buffer.active.cursorX).toBe(2)
  })

  it('keeps colours (rendered attributes), never escapes like OSC 52 the pane received', async () => {
    const terminal = pane(4)
    await write(terminal, '\x1b]52;c;ZXZpbA==\x07\x1b[32mgreen ok\x1b[0m\r\n$ ')
    capture(terminal, 'leaf-1')
    armWakeScrollback(['leaf-1'])
    const restore = beginWakeScrollbackRestore('leaf-1', terminal)!
    expect(restore.block).not.toContain('\x1b]')
    expect(restore.block).toContain('\x1b[0;32mgreen ok')
  })

  it('an agent pane keeps only the scrollback above its screen, never the frozen TUI frame', async () => {
    const terminal = pane(5)
    const earlier = Array.from({ length: 8 }, (_, index) => `earlier ${index + 1}`).join('\r\n')
    await write(terminal, `${earlier}\r\n`)
    await write(terminal, '╭────────╮\r\n│ > Try  │\r\n╰────────╯\r\n ? for shortcuts')
    capture(terminal, 'leaf-a', true)
    armWakeScrollback(['leaf-a'])
    const block = beginWakeScrollbackRestore('leaf-a', terminal)!.block
    expect(block).toContain('earlier 1')
    expect(block).not.toContain('> Try')
    expect(block).not.toContain('for shortcuts')
  })

  it('repeated sleeps: one divider per sleep, in order', async () => {
    const terminal = pane(6)
    await write(terminal, '$ echo one\r\none\r\n$ ')
    capture(terminal, 'leaf-1')
    armWakeScrollback(['leaf-1'])
    await wake(terminal, 'leaf-1', '$ ')
    await write(terminal, 'echo two\r\ntwo\r\n$ ')
    captureWakeScrollback('leaf-1', terminal, {
      sleptAt: SLEPT_AT + 10 * 60_000,
      agentPane: false,
      maxRows: 5000
    })
    armWakeScrollback(['leaf-1'])
    await wake(terminal, 'leaf-1', '$ ')
    const lines = text(terminal)
    const dividers = lines.flatMap((line, index) => (DIVIDER.test(line) ? [index] : []))
    expect(dividers).toHaveLength(2)
    expect(lines.indexOf('one')).toBeLessThan(dividers[0]!)
    expect(lines.indexOf('two')).toBeGreaterThan(dividers[0]!)
    expect(lines.indexOf('two')).toBeLessThan(dividers[1]!)
  })

  it('a snapshot for the new (woken) terminal takes it at once, before React arms it', async () => {
    const terminal = pane(4)
    await write(terminal, '$ ls\r\nREADME\r\n$ ')
    captureWakeScrollback('leaf-1', terminal, {
      sleptAt: SLEPT_AT,
      agentPane: false,
      maxRows: 5000,
      ptyId: 'remote:env::term-old'
    })
    // A cold restore of the old terminal while still asleep: not taken.
    expect(
      beginWakeScrollbackRestore('leaf-1', terminal, Date.now(), 'remote:env::term-old')
    ).toBeNull()
    // The woken terminal's snapshot: taken, even though nothing armed it yet.
    expect(
      beginWakeScrollbackRestore('leaf-1', terminal, Date.now(), 'remote:env::term-new')?.block
    ).toContain('README')
  })

  it('a replay before the workspace leaves "asleep" (a cold restore) does not take it', async () => {
    const terminal = pane(4)
    await write(terminal, '$ ls\r\nREADME\r\n$ ')
    capture(terminal, 'leaf-1')
    expect(beginWakeScrollbackRestore('leaf-1', terminal)).toBeNull()
    armWakeScrollback(['leaf-1'])
    expect(beginWakeScrollbackRestore('leaf-1', terminal)?.block).toContain('README')
    // Done: taken once.
    expect(beginWakeScrollbackRestore('leaf-1', terminal)).toBeNull()
  })

  it('no live buffer (never mounted / restarted while asleep): the plain read-only copy, uncoloured', async () => {
    const terminal = pane(6)
    const readOnlyCopy = vi.fn(async () => ['$ npm test', 'ok 12 tests', '$ '])
    captureWakeScrollback('leaf-1', terminal, {
      sleptAt: SLEPT_AT,
      agentPane: false,
      maxRows: 5000,
      readOnlyCopy
    })
    await vi.waitFor(() => expect(readOnlyCopy).toHaveBeenCalled())
    await Promise.resolve()
    armWakeScrollback(['leaf-1'])
    expect(await wake(terminal, 'leaf-1', '$ ')).toBe(true)
    const lines = text(terminal)
    expect(lines[0]).toBe('$ npm test')
    expect(lines).toContain('ok 12 tests')
    expect(lines.at(-2)).toMatch(DIVIDER)
  })

  it('neither a live buffer nor a read-only copy: restores nothing and says nothing', async () => {
    const terminal = pane(4)
    captureWakeScrollback('leaf-1', terminal, {
      sleptAt: SLEPT_AT,
      agentPane: false,
      maxRows: 5000,
      readOnlyCopy: async () => null
    })
    await Promise.resolve()
    armWakeScrollback(['leaf-1'])
    expect(await wake(terminal, 'leaf-1', '$ ')).toBe(false)
    expect(text(terminal)).toEqual(['$'])
  })

  it('a person who had scrolled up keeps their place instead of jumping', async () => {
    const terminal = pane(5)
    await write(terminal, Array.from({ length: 50 }, (_, index) => `row ${index}`).join('\r\n'))
    terminal.scrollToLine(10)
    capture(terminal, 'leaf-1')
    armWakeScrollback(['leaf-1'])
    await wake(terminal, 'leaf-1', '$ ')
    expect(terminal.buffer.active.viewportY).toBe(10)
  })

  it('forgets a closed pane, and caps the kept rows', async () => {
    const terminal = pane(4)
    await write(terminal, Array.from({ length: 30 }, (_, index) => `row ${index}`).join('\r\n'))
    captureWakeScrollback('leaf-1', terminal, { sleptAt: SLEPT_AT, agentPane: false, maxRows: 5 })
    armWakeScrollback(['leaf-1'])
    const block = beginWakeScrollbackRestore('leaf-1', terminal)!.block
    expect(block).toContain('row 29')
    expect(block).not.toContain('row 24\r')
    captureWakeScrollback('leaf-2', terminal, { sleptAt: SLEPT_AT, agentPane: false, maxRows: 5 })
    forgetWakeScrollback(['leaf-2'])
    armWakeScrollback(['leaf-2'])
    expect(beginWakeScrollbackRestore('leaf-2', terminal)).toBeNull()
  })
})
