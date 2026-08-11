import { Terminal } from '@xterm/headless'
import type { ILink, Terminal as XtermTerminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  createRememberedOsc8LinkProvider,
  installTerminalOsc8LinkMemory,
  type TerminalOsc8LinkMemory
} from './terminal-osc8-link-memory'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

function osc8(uri: string, text: string, id?: string): string {
  return `${ESC}]8;${id ? `id=${id}` : ''};${uri}${BEL}${text}${ESC}]8;;${BEL}`
}

function createTerminal(): XtermTerminal {
  return new Terminal({ allowProposedApi: true, cols: 80, rows: 24 }) as unknown as XtermTerminal
}

async function write(terminal: XtermTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

/** Rewrite a row in place, the way a TUI repaint does. */
async function repaintRow(
  terminal: XtermTerminal,
  oneBasedRow: number,
  content: string
): Promise<void> {
  await write(terminal, `${ESC}[${oneBasedRow};1H${ESC}[2K${content}`)
}

function rowOf(terminal: XtermTerminal, needle: string): number {
  const buffer = terminal.buffer.active
  for (let y = 0; y < buffer.length; y++) {
    if ((buffer.getLine(y)?.translateToString(true) ?? '').includes(needle)) {
      return y
    }
  }
  return -1
}

function registeredOscLinkCount(terminal: XtermTerminal): number {
  // Why: guards the "handler returns false" contract — xterm's own OSC 8
  // registration must still happen, and there is no public API to read it.
  const core = (
    terminal as unknown as {
      _core: { _oscLinkService: { _dataByLinkId: Map<number, unknown> } }
    }
  )._core
  return core._oscLinkService._dataByLinkId.size
}

function provideLinksFor(
  memory: TerminalOsc8LinkMemory,
  bufferLineNumber: number,
  activate = vi.fn()
): ILink[] {
  const provider = createRememberedOsc8LinkProvider({
    getMemory: () => memory,
    linkTooltip: { textContent: '', style: { display: 'none' } } as unknown as HTMLElement,
    openLinkHint: '⌘+click to open',
    activate
  })
  let result: ILink[] | undefined
  provider.provideLinks(bufferLineNumber, (links) => {
    result = links
  })
  return result ?? []
}

describe('installTerminalOsc8LinkMemory', () => {
  it('records the uri and the exact columns the anchor text occupied', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)

    await write(terminal, `LINK: ${osc8('https://ex.net/target', 'TARGET')} tail`)

    expect(memory.size()).toBe(1)
    expect(memory.linksForRow(0)).toEqual([{ uri: 'https://ex.net/target', startX: 6, endX: 12 }])
  })

  it('does not shadow xterm’s own OSC 8 handler', async () => {
    const terminal = createTerminal()
    installTerminalOsc8LinkMemory(terminal)

    await write(terminal, osc8('https://ex.net/passthrough', 'PASS'))

    expect(registeredOscLinkCount(terminal)).toBe(1)
  })

  it('still serves the target after a repaint drops the hyperlink', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, `LINK: ${osc8('https://ex.net/target', 'TARGET')} tail`)

    await repaintRow(terminal, 1, 'LINK: TARGET tail')

    expect(memory.linksForRow(0)[0]?.uri).toBe('https://ex.net/target')
  })

  it('serves a repainted chip that moved to another row', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    const uri = 'file:///tmp/image-cache/1.png'
    await write(terminal, `\r\n\r\n  ⎿  ${osc8(uri, '[Image #1]', 'a0yme3')}`)
    const original = rowOf(terminal, '[Image #1]')

    // Why: Ink shifts its live region, so the chip reappears on a different row
    // with no hyperlink — the row-keyed entry can never match it again.
    await repaintRow(terminal, original + 1, '')
    await repaintRow(terminal, original + 3, '  ⎿  [Image #1]')
    const moved = rowOf(terminal, '[Image #1]')

    expect(moved).not.toBe(original)
    expect(memory.linksForRow(moved)).toEqual([{ uri, startX: 5, endX: 15 }])
  })

  it('prefers the exact row match over the anchor-text match', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, `A ${osc8('https://ex.net/first', 'SAME')}\r\n`)
    await write(terminal, `B ${osc8('https://ex.net/second', 'SAME')}`)

    // Row 0 keeps its own target even though 'SAME' now maps to the newer uri.
    expect(memory.linksForRow(0)).toEqual([{ uri: 'https://ex.net/first', startX: 2, endX: 6 }])
  })

  it('stops serving a row whose text no longer matches anything remembered', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, `LINK: ${osc8('https://ex.net/target', 'TARGET')} tail`)

    await repaintRow(terminal, 1, 'LINK: OTHERX tail')

    expect(memory.linksForRow(0)).toEqual([])
  })

  it('ignores anchor text too short to identify a target by content', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, `go ${osc8('https://ex.net/short', 'x')}\r\n`)

    await write(terminal, 'x on another row')

    expect(memory.linksForRow(1)).toEqual([])
  })

  it('ignores a hyperlink whose text wrapped onto another row', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)

    await write(terminal, `${'x'.repeat(78)}${osc8('https://ex.net/wrapped', 'WRAPPED')}`)

    expect(memory.size()).toBe(0)
  })

  it('drops every marker, target and the parser handler on dispose', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, osc8('https://ex.net/first', 'FIRST'))
    expect(memory.size()).toBe(1)

    memory.dispose()
    expect(memory.size()).toBe(0)
    expect(memory.linksForRow(0)).toEqual([])

    await write(terminal, `\r\n${osc8('https://ex.net/second', 'SECOND')}`)
    expect(memory.size()).toBe(0)
  })
})

describe('createRememberedOsc8LinkProvider', () => {
  it('exposes a 1-based inclusive range over the remembered columns', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, `LINK: ${osc8('https://ex.net/target', 'TARGET')} tail`)
    await repaintRow(terminal, 1, 'LINK: TARGET tail')

    const [link] = provideLinksFor(memory, 1)
    expect(link.text).toBe('https://ex.net/target')
    expect(link.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 12, y: 1 } })
  })

  it('activates with the remembered uri and the originating event', async () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)
    await write(terminal, osc8('file:///tmp/image-cache/1.png', '[Image #1]'))
    await repaintRow(terminal, 1, '[Image #1]')

    const activate = vi.fn()
    const links = provideLinksFor(memory, 1, activate)
    const event = { metaKey: true } as unknown as MouseEvent
    links[0].activate(event, links[0].text)

    expect(activate).toHaveBeenCalledWith('file:///tmp/image-cache/1.png', event)
  })

  it('reports no links when nothing is remembered for the row', () => {
    const terminal = createTerminal()
    const memory = installTerminalOsc8LinkMemory(terminal)

    expect(provideLinksFor(memory, 1)).toEqual([])
  })
})
