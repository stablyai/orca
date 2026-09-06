/**
 * #18779: emoji presentation sequences advanced one cell where Windows Terminal
 * and Ghostty advance two, so TUIs that budget them as two lost their alignment.
 *
 * The measurement is the cursor advance after writing a grapheme, which is what a
 * DSR/CPR probe reads and what a TUI's layout has to agree with.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from './terminal-unicode-provider'

function openTerminal(): Terminal {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal as never)
  return terminal
}

async function write(terminal: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(text, () => resolve())
  })
}

async function cursorAdvance(terminal: Terminal, grapheme: string): Promise<number> {
  await write(terminal, '\x1b[H\x1b[2J')
  await write(terminal, grapheme)
  return terminal.buffer.active.cursorX
}

const VS16 = '\u{FE0F}'
const VS15 = '\u{FE0E}'
const ZWJ = '\u{200D}'

describe('Orca terminal unicode provider', () => {
  it('advances two cells for a VS16 emoji presentation sequence', async () => {
    const terminal = openTerminal()

    await expect(cursorAdvance(terminal, `\u{1F5A5}${VS16}`)).resolves.toBe(2)
    await expect(cursorAdvance(terminal, `\u{26A0}${VS16}`)).resolves.toBe(2)
    await expect(cursorAdvance(terminal, `\u{2764}${VS16}`)).resolves.toBe(2)

    terminal.dispose()
  })

  it('advances two cells for a keycap sequence', async () => {
    const terminal = openTerminal()

    await expect(cursorAdvance(terminal, `1${VS16}\u{20E3}`)).resolves.toBe(2)

    terminal.dispose()
  })

  it('leaves a text-presentation base at one cell', async () => {
    const terminal = openTerminal()

    // VS15 asks for the text presentation, so the base keeps its narrow width.
    await expect(cursorAdvance(terminal, `\u{26A0}${VS15}`)).resolves.toBe(1)
    await expect(cursorAdvance(terminal, '\u{26A0}')).resolves.toBe(1)
    await expect(cursorAdvance(terminal, '\u{1F5A5}')).resolves.toBe(1)
    await expect(cursorAdvance(terminal, 'abc')).resolves.toBe(3)

    terminal.dispose()
  })

  it('keeps already-wide graphemes at two cells', async () => {
    const terminal = openTerminal()

    await expect(cursorAdvance(terminal, '\u{4E2D}')).resolves.toBe(2)
    await expect(cursorAdvance(terminal, '\u{2705}')).resolves.toBe(2)
    await expect(cursorAdvance(terminal, '\u{1F1E8}\u{1F1F3}')).resolves.toBe(2)
    await expect(
      cursorAdvance(terminal, `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`)
    ).resolves.toBe(2)
    // A ZWJ sequence whose parts carry VS16 must still collapse to one wide cell.
    await expect(
      cursorAdvance(terminal, `\u{1F468}${ZWJ}\u{2764}${VS16}${ZWJ}\u{1F468}`)
    ).resolves.toBe(2)

    terminal.dispose()
  })
})
