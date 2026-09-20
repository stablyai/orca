import { describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { Terminal as RendererTerminal } from '@xterm/xterm'
import {
  createTerminalOscLinkRetirement,
  TerminalOscLinkRetirementAddon
} from './terminal-osc-link-retirement'

const URL = 'https://example.test/link'
const OPEN = `\x1b]8;;${URL}\x1b\\`
const CLOSE = '\x1b]8;;\x1b\\'
const REDRAW = `\r\x1b[2K${OPEN}x${CLOSE}`

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function linkRegistry(terminal: unknown): Map<unknown, unknown> {
  if (
    !record(terminal) ||
    !record(terminal._core) ||
    !record(terminal._core._oscLinkService) ||
    !(terminal._core._oscLinkService._dataByLinkId instanceof Map)
  ) {
    throw new Error('Installed xterm link registry changed')
  }
  return terminal._core._oscLinkService._dataByLinkId
}

function cellUri(
  terminal: HeadlessTerminal | RendererTerminal,
  buffer: 'normal' | 'alternate',
  row: number,
  column: number
): unknown {
  const cell = terminal.buffer[buffer].getLine(row)?.getCell(column)
  if (!record(cell) || !record(cell.extended)) {
    return undefined
  }
  const entry = linkRegistry(terminal).get(cell.extended.urlId)
  return record(entry) && record(entry.data) ? entry.data.uri : undefined
}

function hasUri(
  terminal: HeadlessTerminal | RendererTerminal,
  buffer: 'normal' | 'alternate',
  uri: string
): boolean {
  const lines = terminal.buffer[buffer]
  for (let row = 0; row < lines.length; row++) {
    const line = lines.getLine(row)
    if (!line) {
      continue
    }
    for (let column = 0; column < line.length; column++) {
      if (cellUri(terminal, buffer, row, column) === uri) {
        return true
      }
    }
  }
  return false
}

function write(terminal: HeadlessTerminal | RendererTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe.each([
  ['headless', HeadlessTerminal],
  ['renderer', RendererTerminal]
] as const)('%s OSC link retirement', (_kind, Terminal) => {
  function createTerminal(): HeadlessTerminal | RendererTerminal {
    return new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 1500,
      allowProposedApi: true,
      logLevel: 'off'
    })
  }

  it.each(['overwrite', 'erase-line', 'alternate'] as const)(
    'bounds %s redraws without losing the live link or unrelated markers',
    async (mode) => {
      const terminal = createTerminal()
      const retirement = createTerminalOscLinkRetirement(terminal)
      try {
        if (mode === 'alternate') {
          await write(terminal, '\x1b[?1049h')
        }
        const marker = terminal.registerMarker(0)
        const redraw = mode === 'overwrite' ? `\r${OPEN}x${CLOSE}` : REDRAW
        for (let batch = 0; batch < 16; batch++) {
          await write(terminal, redraw.repeat(256))
          retirement()
        }
        expect(terminal.buffer.active.length).toBe(24)
        expect(linkRegistry(terminal).size).toBeLessThanOrEqual(1024)
        expect(terminal.markers.length).toBeLessThanOrEqual(1025)
        expect(marker?.isDisposed).toBe(false)
        expect(cellUri(terminal, mode === 'alternate' ? 'alternate' : 'normal', 0, 0)).toBe(URL)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('keeps every scrollback link while the alternate screen is repainted', async () => {
    const terminal = createTerminal()
    terminal.loadAddon(new TerminalOscLinkRetirementAddon())
    try {
      for (let row = 0; row < 1100; row++) {
        await write(terminal, `\x1b]8;id=row-${row};https://example.test/${row}\x1b\\x${CLOSE}\r\n`)
      }
      await write(terminal, '\x1b[?1049h\x1b[H')
      for (let batch = 0; batch < 16; batch++) {
        await write(terminal, REDRAW.repeat(256))
      }
      expect(linkRegistry(terminal).size).toBeLessThanOrEqual(1100 + 1024)
      for (let row = 0; row < 1100; row++) {
        expect(cellUri(terminal, 'normal', row, 0)).toBe(`https://example.test/${row}`)
      }
      expect(cellUri(terminal, 'alternate', 0, 0)).toBe(URL)
    } finally {
      terminal.dispose()
    }
  })

  it('keeps an open link whose text arrives in a later write', async () => {
    const terminal = createTerminal()
    const retirement = createTerminalOscLinkRetirement(terminal)
    try {
      await write(terminal, `${REDRAW.repeat(1024)}\r\x1b[2K\x1b]8;;${URL}/pending\x1b\\`)
      expect(retirement()).toBeGreaterThan(1000)
      await write(terminal, `pending${CLOSE}`)
      expect(cellUri(terminal, 'normal', 0, 0)).toBe(`${URL}/pending`)
    } finally {
      terminal.dispose()
    }
  })

  it('preserves partially overwritten and reflowed links, then permits reuse of a retired explicit id', async () => {
    const terminal = createTerminal()
    const retirement = createTerminalOscLinkRetirement(terminal)
    try {
      await write(terminal, `\x1b]8;id=stable;${URL}/kept\x1b\\${'x'.repeat(160)}${CLOSE}\r `)
      terminal.resize(40, 24)
      await write(terminal, `\x1b[10;1H${REDRAW.repeat(1024)}`)
      retirement()
      expect(cellUri(terminal, 'normal', 0, 0)).toBe(`${URL}/kept`)
      await write(terminal, `\x1b[10;1H\x1b]8;id=retired;${URL}/old\x1b\\x${CLOSE}`)
      await write(terminal, REDRAW.repeat(2048))
      retirement()
      await write(terminal, `\r\x1b]8;id=retired;${URL}/old\x1b\\x${CLOSE}`)
      expect(cellUri(terminal, 'normal', 9, 0)).toBe(`${URL}/old`)
    } finally {
      terminal.dispose()
    }
  })

  it.each(['reflow', 'insert-delete', 'scroll', 'alternate'] as const)(
    'keeps a live link after %s while pruning links from the same marker row',
    async (mode) => {
      const terminal = new Terminal({
        cols: 20,
        rows: 5,
        scrollback: 500,
        allowProposedApi: true,
        logLevel: 'off'
      })
      const retirement = createTerminalOscLinkRetirement(terminal)
      const liveUri = `${URL}/${mode}/live`
      try {
        await write(terminal, `\x1b]8;;${liveUri}\x1b\\${'live-link-'.repeat(10)}${CLOSE}`)
        if (mode === 'reflow') {
          terminal.resize(8, 5)
        } else if (mode === 'insert-delete') {
          await write(terminal, '\x1b[1;1H\x1b[1L')
        } else if (mode === 'scroll') {
          await write(terminal, '\x1b[5;1H\n\n')
        } else {
          await write(terminal, '\x1b[?1049h')
        }
        await write(terminal, '\x1b[5;1H')
        for (let index = 0; index < 1024; index++) {
          await write(terminal, `\r\x1b[2K${OPEN}s${CLOSE}`)
        }
        retirement()
        expect(hasUri(terminal, 'normal', liveUri)).toBe(true)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('keeps wrapped continuation cells when reflow erased the marker row', async () => {
    const terminal = new HeadlessTerminal({
      cols: 20,
      rows: 5,
      scrollback: 500,
      allowProposedApi: true,
      logLevel: 'off'
    })
    const retirement = createTerminalOscLinkRetirement(terminal)
    const liveUri = `${URL}/reflow-erased-marker`
    try {
      await write(terminal, `\x1b]8;;${liveUri}\x1b\\abcdefghijklmno${CLOSE}\r\n`)
      terminal.resize(5, 5)
      await write(terminal, '\x1b[1;1H\x1b[2K\x1b[5;1H')
      for (let index = 0; index < 1024; index++) {
        await write(terminal, `\r\x1b[2K${OPEN}s${CLOSE}`)
      }
      retirement()
      expect(hasUri(terminal, 'normal', liveUri)).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

  it('bounds redraws when alternate-screen exits remove entries between additions', async () => {
    const terminal = createTerminal()
    const retirement = createTerminalOscLinkRetirement(terminal)
    try {
      for (let frame = 0; frame < 1300; frame++) {
        await write(terminal, REDRAW)
        retirement()
        await write(terminal, `\x1b[?1049h${REDRAW}`)
        retirement()
        await write(terminal, '\x1b[?1049l')
        retirement()
      }
      expect(linkRegistry(terminal).size).toBeLessThanOrEqual(1024)
      expect(terminal.markers.length).toBeLessThanOrEqual(1024)
      expect(cellUri(terminal, 'normal', 0, 0)).toBe(URL)
    } finally {
      terminal.dispose()
    }
  })

  it.each(['autowrap', 'resize-back'] as const)(
    'preserves unmarked live cells after %s',
    async (mode) => {
      const terminal = createTerminal()
      terminal.resize(20, 24)
      terminal.loadAddon(new TerminalOscLinkRetirementAddon())
      const liveUri = `${URL}/${mode}`
      try {
        await write(terminal, `\x1b]8;;${liveUri}\x1b\\${'a'.repeat(21)}${CLOSE}`)
        if (mode === 'resize-back') {
          terminal.resize(5, 24)
          terminal.resize(20, 24)
        }
        await write(terminal, '\x1b[1;1H\x1b[2K')
        expect(hasUri(terminal, 'normal', liveUri)).toBe(true)
        await write(terminal, `\x1b[24;1H${REDRAW.repeat(1100)}`)
        expect(linkRegistry(terminal).size).toBeLessThanOrEqual(1024)
        expect(hasUri(terminal, 'normal', liveUri)).toBe(true)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('scans all rows when marker metadata is incomplete', async () => {
    const terminal = createTerminal()
    const retirement = createTerminalOscLinkRetirement(terminal)
    try {
      await write(terminal, 'plain text\r\n'.repeat(1500))
      await write(terminal, REDRAW.repeat(1024))
      expect(retirement()).toBe(1023)
      expect(hasUri(terminal, 'normal', URL)).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

  it('preserves links when an unfamiliar line layout requires the public cell scan', async () => {
    const terminal = createTerminal()
    const retirement = createTerminalOscLinkRetirement(terminal)
    const buffer = terminal.buffer.normal
    const getLine = buffer.getLine.bind(buffer)
    const publicLines = vi.spyOn(buffer, 'getLine').mockImplementation((row) => {
      const line = getLine(row)
      return (
        line && {
          isWrapped: line.isWrapped,
          length: line.length,
          getCell: line.getCell.bind(line),
          translateToString: line.translateToString.bind(line)
        }
      )
    })
    try {
      await write(terminal, REDRAW.repeat(1024))
      expect(retirement()).toBe(1023)
      expect(cellUri(terminal, 'normal', 0, 0)).toBe(URL)
    } finally {
      publicLines.mockRestore()
      terminal.dispose()
    }
  })
})
