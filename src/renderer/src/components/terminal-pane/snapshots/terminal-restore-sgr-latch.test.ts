import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreScrollbackBuffers } from './saved-terminal-output-replay'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

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
})
