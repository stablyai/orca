import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  installTerminalMouseEncodingTracker,
  terminalMouseEncodingRestoreAnsi
} from './terminal-mouse-encoding-tracker'

const ESC = '\x1b'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

type XtermMouseStateAccess = { _core?: { mouseStateService?: { activeEncoding?: string } } }

// xterm's own (private) encoding, so each case also proves the mirror agrees with xterm.
function xtermEncoding(terminal: Terminal): string | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only read of xterm's private mouse state; every level is optional.
  return (terminal as unknown as XtermMouseStateAccess)._core?.mouseStateService?.activeEncoding
}

async function trackedAfter(...chunks: string[]) {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  installTerminalMouseEncodingTracker(terminal)
  for (const chunk of chunks) {
    await write(terminal, chunk)
  }
  return { restore: terminalMouseEncodingRestoreAnsi(terminal), xterm: xtermEncoding(terminal) }
}

describe('terminal mouse encoding tracker', () => {
  it.each([
    ['nothing', [], '', 'DEFAULT'],
    ['SGR (1006h)', [`${ESC}[?1006h`], `${ESC}[?1006h`, 'SGR'],
    ['SGR pixels (1016h)', [`${ESC}[?1016h`], `${ESC}[?1016h`, 'SGR_PIXELS'],
    ['a combined ?1003;1006h', [`${ESC}[?1003;1006h`], `${ESC}[?1006h`, 'SGR'],
    [
      'the Codex start-up sequence',
      [`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1015h${ESC}[?1006h`],
      `${ESC}[?1006h`,
      'SGR'
    ],
    ['the last of ?1006;1016h', [`${ESC}[?1006;1016h`], `${ESC}[?1016h`, 'SGR_PIXELS'],
    ['1006l after 1006h', [`${ESC}[?1006h`, `${ESC}[?1006l`], '', 'DEFAULT'],
    // xterm resets to the default on either reset, not only the active one.
    ['1006l after 1016h', [`${ESC}[?1016h`, `${ESC}[?1006l`], '', 'DEFAULT'],
    ['1016l after 1006h', [`${ESC}[?1006h`, `${ESC}[?1016l`], '', 'DEFAULT'],
    ['RIS after 1006h', [`${ESC}[?1006h`, `${ESC}c`], '', 'DEFAULT'],
    ['a DECSET split across writes', [`${ESC}[?10`, '06h'], `${ESC}[?1006h`, 'SGR'],
    ['a non-mouse private mode', [`${ESC}[?1006h`, `${ESC}[?25l`], `${ESC}[?1006h`, 'SGR']
  ])('mirrors %s', async (_name, chunks, restore, xterm) => {
    expect(await trackedAfter(...chunks)).toEqual({ restore, xterm })
  })

  it('stops tracking once disposed', async () => {
    const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    const tracker = installTerminalMouseEncodingTracker(terminal)
    await write(terminal, `${ESC}[?1006h`)
    tracker.dispose()
    expect(terminalMouseEncodingRestoreAnsi(terminal)).toBe('')
  })

  it('tolerates a terminal without a parser', () => {
    const terminal = {}
    installTerminalMouseEncodingTracker(terminal).dispose()
    expect(terminalMouseEncodingRestoreAnsi(terminal)).toBe('')
  })
})
