import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeWithAbsoluteCursor } from '../../../../shared/terminal-serialize-absolute-cursor'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE
} from '../../../../shared/terminal-mode-reset-profiles'
import { restoreScrollbackBuffers } from './layout-serialization'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const UNCLOSED_BOLD_FIXTURE = 'ORCA-SGR-REPRO \x1b[1mBOLD-RUN-LEFT-OPEN\x1b[1;34H'
const terminals: Terminal[] = []

function createTerminal(): Terminal {
  const terminal = new Terminal({ cols: 40, rows: 6, scrollback: 20, allowProposedApi: true })
  terminals.push(terminal)
  return terminal
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function boldAtText(terminal: Terminal, text: string): number {
  const buffer = terminal.buffer.normal
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    const column = line?.translateToString(true).indexOf(text) ?? -1
    if (line && column >= 0) {
      return line.getCell(column)?.isBold() ?? 0
    }
  }
  throw new Error(`Missing terminal text: ${text}`)
}

function foregroundAtText(terminal: Terminal, text: string): number {
  const buffer = terminal.buffer.normal
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    const column = line?.translateToString(true).indexOf(text) ?? -1
    if (line && column >= 0) {
      return line.getCell(column)?.getFgColor() ?? -1
    }
  }
  throw new Error(`Missing terminal text: ${text}`)
}

async function restoreBuffer(
  buffer: string,
  options: { initialState?: string; followingOutput?: string } = {}
): Promise<Terminal> {
  const terminal = createTerminal()
  if (options.initialState) {
    await writeTerminal(terminal, options.initialState)
  }
  const pane = { id: 1, terminal }
  const manager = {
    getPanes: () => [pane],
    hasWebglRenderer: () => true
  }
  restoreScrollbackBuffers(
    manager as unknown as Parameters<typeof restoreScrollbackBuffers>[0],
    { [LEAF_ID]: buffer },
    new Map([[LEAF_ID, pane.id]]),
    { current: new Map() }
  )
  await writeTerminal(terminal, options.followingOutput ?? 'fresh-shell')
  return terminal
}

function serialize(data: string): { terminal: Terminal; addon: SerializeAddon; data: string } {
  const terminal = createTerminal()
  const addon = new SerializeAddon()
  terminal.loadAddon(addon)
  return { terminal, addon, data }
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
})

describe('fresh-shell terminal restore SGR state', () => {
  it('grounds the pen before replaying normal-buffer cells', async () => {
    const restored = await restoreBuffer('plain-history', { initialState: '\x1b[1m' })

    expect(boldAtText(restored, 'plain-history')).toBe(0)
  })

  it('clears an unclosed bold run before fresh shell output', async () => {
    const restored = await restoreBuffer('\x1b[1mBOLD')

    expect(boldAtText(restored, 'BOLD')).not.toBe(0)
    expect(boldAtText(restored, 'fresh-shell')).toBe(0)
  })

  it('grounds the erase attributes before the restored newline scrolls', async () => {
    const restored = await restoreBuffer('\x1b[6;1H\x1b[41mX', { followingOutput: '' })
    const buffer = restored.buffer.active
    const bottomLine = buffer.getLine(buffer.baseY + restored.rows - 1)

    expect(bottomLine?.getCell(20)?.getBgColor()).toBe(-1)
  })

  it('clears the serialized live pen before fresh shell output', async () => {
    const source = serialize('\x1b[1mBOLD')
    await writeTerminal(source.terminal, source.data)

    const restored = await restoreBuffer(source.addon.serialize())

    expect(boldAtText(restored, 'BOLD')).not.toBe(0)
    expect(boldAtText(restored, 'fresh-shell')).toBe(0)
  })

  it('clears the captured pen after normal-buffer daemon reattach', async () => {
    const terminal = createTerminal()
    await writeTerminal(terminal, UNCLOSED_BOLD_FIXTURE)
    await writeTerminal(terminal, POST_REPLAY_REATTACH_RESET)
    await writeTerminal(terminal, 'PLAIN-TEXT-NO-SGR-WHATSOEVER')

    expect(boldAtText(terminal, 'BOLD-RUN-LEFT-OPEN')).not.toBe(0)
    expect(boldAtText(terminal, 'PLAIN')).toBe(0)
  })

  it.each([
    ['live agent', POST_REPLAY_LIVE_AGENT_REATTACH_RESET],
    ['alternate-screen TUI', POST_REPLAY_REATTACH_RESET_KEEP_MOUSE]
  ])('preserves a %s pen across daemon reattach', async (_kind, reset) => {
    const terminal = createTerminal()
    await writeTerminal(terminal, 'ORCA-SGR-REPRO \x1b[1;34mBOLD-RUN-LEFT-OPEN\x1b[1;34H')
    await writeTerminal(terminal, reset)
    await writeTerminal(terminal, 'LIVE-CONTINUATION')

    expect(boldAtText(terminal, 'BOLD-RUN-LEFT-OPEN')).not.toBe(0)
    expect(boldAtText(terminal, 'LIVE')).not.toBe(0)
    expect(foregroundAtText(terminal, 'LIVE')).toBe(4)
  })

  it('clears the captured pen and saved cursor for a fresh shell', async () => {
    const terminal = createTerminal()
    await writeTerminal(terminal, '\x1b[1mBOLD-RUN-LEFT-OPEN\x1b7')
    await writeTerminal(terminal, POST_REPLAY_MODE_RESET)
    await writeTerminal(terminal, '\x1b8PLAIN')

    expect(boldAtText(terminal, 'PLAIN')).toBe(0)
    expect(foregroundAtText(terminal, 'PLAIN')).toBe(-1)
  })

  it('keeps the synthetic saved-cursor register from restoring bold', async () => {
    const source = serialize('\x1b[1mBOLD')
    await writeTerminal(source.terminal, source.data)
    const snapshot = serializeWithAbsoluteCursor(source.addon, source.terminal, undefined, {
      x: 10,
      y: 0,
      originMode: false
    })

    const restored = await restoreBuffer(snapshot, { followingOutput: '\x1b8after-restore' })

    expect(boldAtText(restored, 'after-restore')).toBe(0)
  })

  it('grounds the synthetic saved cursor after normal-buffer daemon reattach', async () => {
    const source = serialize('\x1b[1mBOLD')
    await writeTerminal(source.terminal, source.data)
    const snapshot = serializeWithAbsoluteCursor(source.addon, source.terminal, undefined, {
      x: 10,
      y: 0,
      originMode: false
    })
    const restored = createTerminal()

    await writeTerminal(restored, snapshot)
    await writeTerminal(restored, POST_REPLAY_REATTACH_RESET)
    await writeTerminal(restored, '\x1b8after-reattach')

    expect(boldAtText(restored, 'after-reattach')).toBe(0)
  })

  it('restores alt-screen scrollback without leaking its bold frame', async () => {
    const source = serialize('shell-history\x1b[?1049h\x1b[1mBOLD-TUI')
    await writeTerminal(source.terminal, source.data)

    const restored = await restoreBuffer(source.addon.serialize())

    expect(boldAtText(restored, 'shell-history')).toBe(0)
    expect(boldAtText(restored, 'fresh-shell')).toBe(0)
  })
})
