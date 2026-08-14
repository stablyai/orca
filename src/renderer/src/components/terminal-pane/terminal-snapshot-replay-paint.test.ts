import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue,
  RESET_AFTER_BYTE_GAP
} from '../../../../shared/terminal-mode-reset-profiles'
import {
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  cursorPosition,
  normalBufferRowsTrimmed,
  visibleRowStyles,
  writeToTerminal
} from '../../../../shared/terminal-restore-parity-fixture'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  resolvePositiveTerminalDimensions,
  shouldSkipAltFrameForWidthMismatch
} from './terminal-snapshot-replay-paint'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

const NORMAL_BUFFER_PROLOGUE_FROM_ALT = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue({ targetAlternateScreen: false, paneOnAlternateScreen: true })}`
const NORMAL_BUFFER_PROLOGUE = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue({ targetAlternateScreen: false, paneOnAlternateScreen: false })}`
const ALT_BUFFER_PROLOGUE = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: false })}`
// A pane already in alt screen is the production case for an alt snapshot, and
// it is NOT the same bytes: no switch, so none of `?1049h`'s side effects run.
const ALT_BUFFER_PROLOGUE_FROM_ALT = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: true })}`

function readRows(terminal: Terminal, count: number): (string | undefined)[] {
  return Array.from({ length: count }, (_, row) =>
    terminal.buffer.active.getLine(row)?.translateToString(true)
  )
}

describe('RESET_AFTER_BYTE_GAP', () => {
  // Real emulator rather than a mock: the guarantee is that a cell written after
  // the gap reset carries none of the pen the gap stranded (STA-4042).
  it('grounds the SGR pen so post-gap cells are not bold', async () => {
    const terminal = new Terminal({ cols: 40, rows: 2, allowProposedApi: true })
    try {
      // Bold opened and never closed — exactly what a dropped `ESC[22m` leaves.
      await writeTerminal(terminal, '\x1b[1mBOLD')
      await writeTerminal(terminal, `${RESET_AFTER_BYTE_GAP}after`)

      const line = terminal.buffer.active.getLine(0)
      expect(line?.translateToString(true)).toBe('BOLDafter')
      // The pre-gap run keeps its bold; only what follows the reset is grounded.
      expect(line?.getCell(0)?.isBold()).not.toBe(0)
      expect(line?.getCell(4)?.isBold()).toBe(0)
      expect(line?.getCell(8)?.isBold()).toBe(0)
    } finally {
      terminal.dispose()
    }
  })

  // xterm dispatches OSC/DCS/APC with `success = code !== 0x18 && code !== 0x1a`,
  // so a bare ESC would COMMIT whatever the gap truncated. Without the CAN this
  // retitles the pane from a half-read OSC 0 (and writes the clipboard from a
  // half-read OSC 52).
  it('discards a control string the gap truncated instead of committing it', async () => {
    const terminal = new Terminal({ cols: 40, rows: 2, allowProposedApi: true })
    let title = ''
    terminal.onTitleChange((next) => {
      title = next
    })
    try {
      await writeTerminal(terminal, '\x1b]0;real-title-TRUNCA')
      await writeTerminal(terminal, `${RESET_AFTER_BYTE_GAP}after`)

      expect(title).toBe('')
      // Still resynchronised: the bytes after the reset render as text.
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('after')
    } finally {
      terminal.dispose()
    }
  })
})

// The end-to-end invariant, built through the SAME composer production uses
// (buildParityMainBufferSnapshot mirrors HeadlessEmulator.getSnapshot: absolute
// cursor + DECSC epilogue, the alt frame split from normal scrollback, and the
// rehydrate prefix owning the single `?1049h`). Whatever the gap stranded, a
// dirty renderer must land on exactly the frame a clean one produces. The
// per-element tests below pin *why*; this pins what a user would notice.
describe('replay convergence with a production-composed snapshot', () => {
  const strandedByTheGap: Record<string, string> = {
    'bold pen': '\x1b[1m',
    'G0 line drawing': '\x1b(0',
    'scroll margins': '\x1b[2;3r',
    'origin mode': '\x1b[2;3r\x1b[?6h',
    'autowrap off': '\x1b[?7l',
    'insert mode': '\x1b[4h',
    'reverse wraparound': '\x1b[?45h',
    'saved-cursor register': '\x1b7',
    'truncated OSC': '\x1b]0;TRUNCATED',
    'all of them at once':
      '\x1b[1m\x1b(0\x1b)0\x1b[2;3r\x1b[?6h\x1b[?7l\x1b[?45h\x1b[4h\x1b7\x1b]0;TRUNCATED'
  }

  function describeFrame(terminal: Terminal): string {
    return JSON.stringify({
      buffer: terminal.buffer.active.type,
      rows: readRows(terminal, terminal.rows),
      normal: readRows(terminal, terminal.rows).length > 0 ? normalBufferRowsTrimmed(terminal) : [],
      styles: visibleRowStyles(terminal),
      cursor: cursorPosition(terminal)
    })
  }

  for (const alternateScreen of [true, false]) {
    const branch = alternateScreen ? 'alt-screen' : 'normal-buffer'
    it(`lands on the same ${branch} frame from any stranded state`, async () => {
      const model = createRendererParityTerminal({ cols: 20, rows: 5 })
      try {
        const enterAlt = alternateScreen ? '\x1b[?1049h' : ''
        // The DECSC makes readSavedCursorRegister return a real register, so the
        // snapshot carries the absolute-cursor epilogue (`\x1b[r`, `?6l`, CUP,
        // `\x1b7`) — without it that whole branch of the payload never fires.
        await writeToTerminal(
          model.terminal,
          `${enterAlt}\x1b[2;5H\x1b7\x1b[33mONE\r\nplain two\r\n\x1b[1mbold three`
        )
        const snapshot = buildParityMainBufferSnapshot(model, 1)
        expect(snapshot.alternateScreen).toBe(alternateScreen)
        // Pin that this is the production shape: the alt case must take the
        // split branch, and the payload must carry the cursor epilogue.
        expect(snapshot.scrollbackAnsi === undefined).toBe(!alternateScreen)
        expect(snapshot.data).toContain('\x1b7')

        const replay = async (terminal: Terminal): Promise<void> => {
          for (const write of buildMainModelSnapshotReplayWrites(snapshot, {
            paneOnAlternateScreen: alternateScreen
          })) {
            await writeTerminal(terminal, write)
          }
        }

        const clean = createRendererParityTerminal({ cols: 20, rows: 5 })
        let expected: string
        try {
          await writeToTerminal(clean.terminal, enterAlt)
          await replay(clean.terminal)
          expected = describeFrame(clean.terminal)
        } finally {
          clean.terminal.dispose()
        }

        for (const [label, stranded] of Object.entries(strandedByTheGap)) {
          const dirty = createRendererParityTerminal({ cols: 20, rows: 5 })
          try {
            await writeToTerminal(dirty.terminal, enterAlt)
            await writeToTerminal(dirty.terminal, stranded)
            await replay(dirty.terminal)
            expect(`${label}: ${describeFrame(dirty.terminal)}`).toBe(`${label}: ${expected}`)
          } finally {
            dirty.terminal.dispose()
          }
        }
      } finally {
        model.terminal.dispose()
      }
    })
  }
})

// Each case strands one piece of carried state, then replays a payload through
// the real prologue. SerializeAddon diffs against the default cell and emits no
// charset at all, so anything the gap left set silently rewrites the frame.
describe('replay baseline grounding', () => {
  const strandedState: Record<string, string> = {
    'bold pen': '\x1b[1m',
    'DEC line-drawing charset': '\x1b(0',
    'scroll region': '\x1b[2;3r',
    'origin mode': '\x1b[2;3r\x1b[?6h'
  }

  for (const [label, stranded] of Object.entries(strandedState)) {
    it(`replays a normal-buffer snapshot unchanged despite a stranded ${label}`, async () => {
      const terminal = new Terminal({ cols: 10, rows: 6, allowProposedApi: true })
      try {
        await writeTerminal(terminal, stranded)
        await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE}qqq\r\nB\r\nC\r\nD\r\nE\r\nF`)

        expect(readRows(terminal, 6)).toEqual(['qqq', 'B', 'C', 'D', 'E', 'F'])
        expect(terminal.buffer.active.getLine(0)?.getCell(0)?.isBold()).toBe(0)
      } finally {
        terminal.dispose()
      }
    })
  }

  // The field path, driven through the REAL builder output rather than a
  // hand-written prologue: an alt-screen agent whose snapshot splits normal
  // scrollback from the alt frame. This is the branch STA-4042 was reported on.
  it('replays a split alt-screen snapshot clean when the TUI entered alt with a pen set', async () => {
    const terminal = new Terminal({ cols: 24, rows: 4, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[1m\x1b(0')
      // ?1049h saves that pen and charset into the register ?1049l restores from.
      await writeTerminal(terminal, '\x1b[?1049hTUI FRAME')

      for (const write of buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true, scrollbackAnsi: 'qqq scrollback' },
        { paneOnAlternateScreen: true }
      )) {
        await writeTerminal(terminal, write)
      }

      // The alt frame is what shows; the rebuilt normal history must be clean too.
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('alt-frame')
      expect(terminal.buffer.active.getLine(0)?.getCell(0)?.isBold()).toBe(0)
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('qqq scrollback')
      expect(terminal.buffer.normal.getLine(0)?.getCell(0)?.isBold()).toBe(0)
    } finally {
      terminal.dispose()
    }
  })

  // Ordering regression. xterm answers `?1049l` with restoreCursor(), which
  // reloads the pen, every G-set designation, GL, origin mode and wraparound
  // from the register `?1049h` saved. A TUI that was bold and line-drawing when
  // it entered the alt screen therefore gets all of that RESTORED on the way
  // out — so grounding emitted ahead of the buffer switch is silently undone,
  // and the exact bold-bleed this whole path exists to prevent comes back.
  it('grounds after the buffer switch, not before, so ?1049l cannot restore the stale pen', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[1m\x1b(0\x1b[?7l')
      // ?1049h saves that pen, charset and wraparound into the restore register.
      await writeTerminal(terminal, '\x1b[?1049hTUI FRAME')
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE_FROM_ALT}qqq restored`)

      const line = terminal.buffer.active.getLine(0)
      expect(line?.translateToString(true)).toBe('qqq restored')
      expect(line?.getCell(0)?.isBold()).toBe(0)
    } finally {
      terminal.dispose()
    }
  })

  // `?1049l` runs restoreCursor() unconditionally, which rewrites the pen, all
  // four G-sets, GL, origin, wraparound and the cursor from the register saved
  // at `?1049h`. Poison every one of those at once and prove the prologue after
  // the switch neutralises the lot — this is the guard on adding `?1049l` at all.
  it('neutralises every field ?1049l restores, even with the saved register poisoned', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[1;31;44m') // pen: bold + fg + bg
      await writeTerminal(terminal, '\x1b(0\x1b)0\x1b*0\x1b+0') // G0..G3 -> line drawing
      await writeTerminal(terminal, '\x0e') // LS1: GL -> G1
      await writeTerminal(terminal, '\x1b[2;5r\x1b[?6h\x1b[?7l\x1b[4h') // margins, origin, no wrap, insert
      await writeTerminal(terminal, '\x1b[3;7H') // non-home cursor
      await writeTerminal(terminal, '\x1b[?1049hTUI FRAME') // saveCursor() captures all of it

      // 24 columns of `q` into a 20-column grid: only autowrap on, GL=G0 and
      // G0=ASCII produce this, and only a homed cursor starts it on row 0.
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE_FROM_ALT}${'q'.repeat(24)}`)

      expect(terminal.buffer.active.type).toBe('normal')
      expect(readRows(terminal, 2)).toEqual(['q'.repeat(20), 'qqqq'])
      const cell = terminal.buffer.active.getLine(0)?.getCell(0)
      expect(cell?.isBold()).toBe(0)
      expect(cell?.isFgDefault()).toBe(true)
      expect(cell?.isBgDefault()).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

  // Panes run with vtExtensions.kittyKeyboard on, and xterm swaps the kitty
  // flag registers on the ?1049 transition. Without the ?1049l the renderer
  // keeps the agent's negotiated flags after the agent exited, so the pane
  // sends CSI-u key encodings to a plain shell that never asked for them.
  // Replaying the snapshot must land on the same state the model already has.
  it('converges on the model kitty keyboard state when the gap ate the alt-screen exit', async () => {
    const options = {
      cols: 20,
      rows: 4,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    }
    const readKittyFlags = (term: Terminal): unknown => {
      const flags = (term as unknown as { _core: { coreService: { kittyKeyboard: unknown } } })
        ._core.coreService.kittyKeyboard
      // Without this the assertion passes vacuously if xterm renames the field.
      expect(flags).toBeDefined()
      return flags
    }

    // The model ingested every byte: agent entered alt, negotiated kitty, exited.
    const model = new Terminal(options)
    // The renderer missed the exit and is still on alt with the agent's flags.
    const renderer = new Terminal(options)
    try {
      await writeTerminal(model, '\x1b[?1049h\x1b[>1u')
      await writeTerminal(model, '\x1b[?1049l')

      await writeTerminal(renderer, '\x1b[?1049h\x1b[>1u')
      for (const write of buildMainModelSnapshotReplayWrites(
        { data: 'shell prompt $' },
        { paneOnAlternateScreen: true }
      )) {
        await writeTerminal(renderer, write)
      }

      expect(renderer.buffer.active.type).toBe(model.buffer.active.type)
      expect(readKittyFlags(renderer)).toEqual(readKittyFlags(model))
    } finally {
      model.dispose()
      renderer.dispose()
    }
  })

  // Delayed arm of the same defect. `?1049h` banks the CURRENT pen and charsets
  // into the register the TUI's eventual `?1049l` restores from, so grounding
  // only after the switch leaves the gap's state saved for later: the repaint
  // looks clean and the shell prompt comes back bold whenever the agent exits.
  it('grounds before the switch too, so the alt-exit later cannot restore the gap state', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[1m\x1b(0\x1b[?7l')
      await writeTerminal(terminal, `${ALT_BUFFER_PROLOGUE}alt frame`)
      // The agent exits the alt screen some time after the repaint.
      await writeTerminal(terminal, '\x1b[?1049l')
      await writeTerminal(terminal, 'qqq shell prompt')

      const line = terminal.buffer.active.getLine(0)
      expect(line?.translateToString(true)).toBe('qqq shell prompt')
      expect(line?.getCell(0)?.isBold()).toBe(0)
    } finally {
      terminal.dispose()
    }
  })

  // `?1049` is NOT a no-op when the pane is already on the target buffer: xterm
  // skips only the buffer swap and still swaps the kitty flag registers. An
  // agent that negotiated kitty on the normal screen and never entered alt
  // would lose its flags (1 -> 0, Option chords dead) on every normal-buffer
  // restore, so the prologue must not switch when there is nothing to switch.
  it('leaves kitty flags alone when the pane is already on the target buffer', async () => {
    const options = {
      cols: 20,
      rows: 3,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    }
    const readKittyFlags = (term: Terminal): unknown => {
      const flags = (term as unknown as { _core: { coreService: { kittyKeyboard: unknown } } })
        ._core.coreService.kittyKeyboard
      // Without this the assertion passes vacuously if xterm renames the field.
      expect(flags).toBeDefined()
      return flags
    }

    const model = new Terminal(options)
    const renderer = new Terminal(options)
    try {
      await writeTerminal(model, '\x1b[>1u')
      await writeTerminal(renderer, '\x1b[>1u')

      const writes = buildMainModelSnapshotReplayWrites(
        { data: 'restored' },
        { paneOnAlternateScreen: false }
      )
      for (const write of writes) {
        await writeTerminal(renderer, write)
      }

      expect(writes[0]).not.toContain('\x1b[?1049')
      expect(readKittyFlags(renderer)).toEqual(readKittyFlags(model))
    } finally {
      model.dispose()
      renderer.dispose()
    }
  })

  // Reverse wraparound is the same shape as insert and autowrap: the model
  // re-emits `?45h` only when IT has the mode on, so a stranded ON survives the
  // repaint and the live app's next backspace at column 0 eats into the row
  // above instead of staying put.
  it('leaves reverse wraparound off so a later backspace cannot chew the row above', async () => {
    const terminal = new Terminal({ cols: 8, rows: 3, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[?45h')
      // 12 columns into 8 makes row 1 a SOFT wrap of row 0 — the only kind
      // reverse wraparound reverses.
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE}AAAAAAAABBBB`)
      await writeTerminal(terminal, '\b\b\b\b\bX')

      expect(readRows(terminal, 2)).toEqual(['AAAAAAAA', 'XBBB'])
    } finally {
      terminal.dispose()
    }
  })

  // The alt branch cannot make the same promise, and the earlier version of this
  // test only appeared to because it used synthetic payload data. Production alt
  // payloads carry their OWN `\x1b[0m\x1b[?1049h` (buildRehydrateSequences /
  // frameRestoreAnsi), so the flags of an agent that negotiated kitty on the alt
  // screen are still pushed into the main register by the payload. The prologue's
  // contribution is what is testable here: it adds no switch of its own.
  it('adds no buffer switch of its own when the pane is already on the alt screen', async () => {
    const options = {
      cols: 20,
      rows: 3,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    }
    const readKittyFlags = (term: Terminal): unknown => {
      const flags = (term as unknown as { _core: { coreService: { kittyKeyboard: unknown } } })
        ._core.coreService.kittyKeyboard
      // Without this the assertion passes vacuously if xterm renames the field.
      expect(flags).toBeDefined()
      return flags
    }

    const renderer = new Terminal(options)
    try {
      await writeTerminal(renderer, '\x1b[?1049h\x1b[>1u')
      const before = JSON.stringify(readKittyFlags(renderer))

      const writes = buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true },
        { paneOnAlternateScreen: true }
      )
      expect(writes[0]).not.toContain('\x1b[?1049')
      for (const write of writes) {
        await writeTerminal(renderer, write)
      }
      // Nothing in the prologue moved them; only a payload `?1049h` could.
      expect(JSON.stringify(readKittyFlags(renderer))).toBe(before)
    } finally {
      renderer.dispose()
    }
  })

  // Margins are per buffer and the switch does not carry them across, so an
  // alt-target replay from a normal pane must ground the buffer it leaves too —
  // otherwise the stale region resurfaces the moment the TUI exits to normal.
  it('grounds the source buffer margins when switching to the alt screen', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[2;3r')
      for (const write of buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true },
        { paneOnAlternateScreen: false }
      )) {
        await writeTerminal(terminal, write)
      }
      await writeTerminal(terminal, '\x1b[?1049l')
      await writeTerminal(terminal, 'AAAA\r\nBBBB\r\nCCCC\r\nDDDD\r\nEEEE\r\nFFFF')

      expect(readRows(terminal, 6)).toEqual(['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF'])
    } finally {
      terminal.dispose()
    }
  })

  // The inverse of what an earlier revision asserted. Grounding G1-G3 looked
  // right against a stranded designation, but the payload never leaves G0 so it
  // cannot affect the frame, and `enacs=\E(B\E)0` (screen/tmux/vt100 terminfo)
  // designates G1 once at init and then uses bare SO/SI — grounding it renders a
  // live app's box drawing as letters. The model never re-asserts charsets, so
  // there is nothing to complete the reset. Leave the app's G-sets alone.
  it('leaves an app-designated G1 intact so its later shift-out still draws boxes', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    try {
      // enacs: G0 = ASCII, G1 = DEC line drawing. Runs once, at init.
      await writeTerminal(terminal, '\x1b(B\x1b)0')
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE}restored`)
      // smacs / box / rmacs, the way the app draws for the rest of the session.
      await writeTerminal(terminal, '\r\n\x0elqqqk\x0f')

      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('┌───┐')
    } finally {
      terminal.dispose()
    }
  })

  // The baseline is reachable around if the saved-cursor register still holds
  // the gap's state: the live TUI's next `ESC 8` restores that pen and charset
  // straight over the repaint. The prologue's trailing DECSC closes that door.
  it('grounds the saved-cursor register so a later ESC 8 cannot restore the stale pen', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    try {
      // The gap strands a DECSC taken while bold + line-drawing were set.
      await writeTerminal(terminal, '\x1b[1m\x1b(0\x1b7')
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE}restored`)
      // The live TUI restores its cursor, then draws.
      await writeTerminal(terminal, '\x1b8qqq')

      const line = terminal.buffer.active.getLine(0)
      expect(line?.translateToString(true)).toBe('qqqtored')
      expect(line?.getCell(0)?.isBold()).toBe(0)
    } finally {
      terminal.dispose()
    }
  })

  // A serialized row exactly `cols` wide relies on autowrap to continue onto the
  // next row. With DECAWM stranded off, every character past the margin
  // overwrites the last cell and the restored history silently loses text.
  it('replays a row wider than the grid instead of dropping it at the margin', async () => {
    const terminal = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[?7l')
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE}ABCDEFGHIJKLMNO`)

      expect(readRows(terminal, 2)).toEqual(['ABCDEFGHIJ', 'KLMNO'])
    } finally {
      terminal.dispose()
    }
  })

  // Origin mode is invisible during the replay itself (the baseline resets the
  // margins, so margin-relative and absolute addressing coincide), but nothing
  // in the snapshot re-emits `ESC[?6l`. Left stranded, the first scroll region
  // the live TUI sets makes all of its cursor addressing margin-relative.
  it('leaves origin mode off so later cursor addressing stays absolute', async () => {
    const terminal = new Terminal({ cols: 10, rows: 6, allowProposedApi: true })
    try {
      // Alt branch: `?1049h` on an already-alt pane is a no-op, so unlike the
      // normal branch's `?1049l` it restores nothing on its own.
      await writeTerminal(terminal, '\x1b[?1049h')
      await writeTerminal(terminal, '\x1b[2;3r\x1b[?6h')
      await writeTerminal(terminal, `${ALT_BUFFER_PROLOGUE_FROM_ALT}restored`)
      // The live TUI re-establishes its own region and homes the cursor.
      await writeTerminal(terminal, '\x1b[4;6r\x1b[1;1HTOP')

      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('TOPtored')
    } finally {
      terminal.dispose()
    }
  })

  // Insert mode survives the replay itself (the frame is painted onto a cleared
  // screen), but the model only re-emits `ESC[4h` when IT has insert mode on —
  // so a stranded-on renderer keeps it, and every later repaint by the live TUI
  // shifts existing cells right instead of overwriting them.
  it('leaves insert mode off so later repaints overwrite rather than shift', async () => {
    const terminal = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[4h')
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE}OLDTEXT`)
      // A live in-place repaint after the replay, exactly as a TUI would send it.
      await writeTerminal(terminal, '\x1b[1;1HNEW')

      expect(readRows(terminal, 1)).toEqual(['NEWTEXT'])
    } finally {
      terminal.dispose()
    }
  })

  // The alt branch needs its own coverage: leaving the alt screen restores
  // saved modes, so `?1049l` on the normal branch happens to clear autowrap and
  // origin mode for free. `?1049h` does not, and on a pane already in alt screen
  // it is a no-op — nothing but the explicit baseline grounds these.
  for (const [label, stranded, replayed, expected] of [
    ['autowrap off', '\x1b[?7l', 'ABCDEFGHIJKLMNO', ['ABCDEFGHIJ', 'KLMNO']],
    ['origin mode', '\x1b[2;3r\x1b[?6h', 'A\r\nB\r\nC', ['A', 'B', 'C']],
    ['DEC line-drawing charset', '\x1b(0', 'qqq', ['qqq', '']]
  ] as const) {
    it(`grounds a stranded ${label} on the alt-screen branch`, async () => {
      const terminal = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
      try {
        await writeTerminal(terminal, '\x1b[?1049h')
        await writeTerminal(terminal, stranded)
        await writeTerminal(terminal, `${ALT_BUFFER_PROLOGUE_FROM_ALT}${replayed}`)

        expect(readRows(terminal, expected.length)).toEqual([...expected])
      } finally {
        terminal.dispose()
      }
    })
  }

  // Margins are per buffer and `?1049h` only clears them when it actually
  // switches, so a pane already in alt screen keeps the stale region.
  it('grounds the alt buffer margins even when already on the alt screen', async () => {
    const terminal = new Terminal({ cols: 10, rows: 6, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[?1049h')
      await writeTerminal(terminal, '\x1b[2;3r')
      await writeTerminal(terminal, `${ALT_BUFFER_PROLOGUE_FROM_ALT}A\r\nB\r\nC\r\nD\r\nE\r\nF`)

      expect(readRows(terminal, 6)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    } finally {
      terminal.dispose()
    }
  })

  // The gap can eat the TUI's own `?1049l`, leaving the renderer on the alt
  // screen while the model already moved back to normal. Painting the restored
  // history into the alt buffer looks right but leaves scrollback empty and the
  // content vanishes on the next buffer switch.
  it('returns to the normal buffer before replaying a normal-buffer snapshot', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[?1049hSTALE TUI FRAME')
      await writeTerminal(terminal, `${NORMAL_BUFFER_PROLOGUE_FROM_ALT}shell prompt $`)

      expect(terminal.buffer.active.type).toBe('normal')
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('shell prompt $')
    } finally {
      terminal.dispose()
    }
  })
})

describe('hasPositiveTerminalDimensions', () => {
  it('accepts only finite positive numeric pairs', () => {
    expect(hasPositiveTerminalDimensions(80, 24)).toBe(true)
    expect(hasPositiveTerminalDimensions(1, 1)).toBe(true)
  })

  // Why: Infinity passes `> 0` — the exact drift that let a malformed SSH
  // model snapshot reach terminal.resize(Infinity, …).
  it('rejects non-finite, non-positive, and non-numeric values', () => {
    expect(hasPositiveTerminalDimensions(Infinity, 24)).toBe(false)
    expect(hasPositiveTerminalDimensions(80, Infinity)).toBe(false)
    expect(hasPositiveTerminalDimensions(Number.NaN, 24)).toBe(false)
    expect(hasPositiveTerminalDimensions(0, 24)).toBe(false)
    expect(hasPositiveTerminalDimensions(80, -1)).toBe(false)
    expect(hasPositiveTerminalDimensions(undefined, 24)).toBe(false)
    expect(hasPositiveTerminalDimensions('80', 24)).toBe(false)
    expect(hasPositiveTerminalDimensions(null, null)).toBe(false)
  })
})

describe('resolvePositiveTerminalDimensions', () => {
  it('returns the numeric pair only when valid', () => {
    expect(resolvePositiveTerminalDimensions(80, 24)).toEqual({ cols: 80, rows: 24 })
    expect(resolvePositiveTerminalDimensions(Infinity, 24)).toBeNull()
    expect(resolvePositiveTerminalDimensions(undefined, undefined)).toBeNull()
  })
})

describe('buildMainModelSnapshotReplayWrites', () => {
  it('clears normal buffer + scrollback before a normal-buffer snapshot', () => {
    expect(
      buildMainModelSnapshotReplayWrites({ data: 'shell-output' }, { paneOnAlternateScreen: false })
    ).toEqual([NORMAL_BUFFER_PROLOGUE, 'shell-output'])
  })

  // Why: main strips the ?1049h marker when splitting scrollbackAnsi from an
  // alt frame, so the restorer must own the ?1049l rebuild + ?1049h return —
  // painting the composed bytes after a plain clear leaves the TUI frame on
  // the normal buffer.
  it('rebuilds normal buffer then paints a clean alt frame for alt-screen snapshots', () => {
    expect(
      buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true, scrollbackAnsi: 'normal-history' },
        { paneOnAlternateScreen: false }
      )
    ).toEqual([
      NORMAL_BUFFER_PROLOGUE,
      'normal-history',
      buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: false }),
      'alt-frame'
    ])
  })

  it('enters a cleared alt screen when no split scrollback is available', () => {
    expect(
      buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true },
        { paneOnAlternateScreen: false }
      )
    ).toEqual([ALT_BUFFER_PROLOGUE, 'alt-frame'])
  })
})

describe('shouldSkipAltFrameForWidthMismatch', () => {
  it('skips only when the snapshot is WIDER than the target', () => {
    expect(shouldSkipAltFrameForWidthMismatch(135, 128)).toBe(true)
    expect(shouldSkipAltFrameForWidthMismatch(129, 128)).toBe(true)
    expect(shouldSkipAltFrameForWidthMismatch(128, 128)).toBe(false)
    expect(shouldSkipAltFrameForWidthMismatch(100, 120)).toBe(false)
  })

  it('never skips when a width is missing or nonsensical', () => {
    // Why: an unknown width must not cost the user their restored frame.
    expect(shouldSkipAltFrameForWidthMismatch(undefined, 128)).toBe(false)
    expect(shouldSkipAltFrameForWidthMismatch(135, undefined)).toBe(false)
    expect(shouldSkipAltFrameForWidthMismatch(0, 128)).toBe(false)
    expect(shouldSkipAltFrameForWidthMismatch(Number.NaN, 128)).toBe(false)
    expect(shouldSkipAltFrameForWidthMismatch(Number.POSITIVE_INFINITY, 128)).toBe(false)
  })
})

describe('buildMainModelSnapshotReplayWrites alt-frame skip', () => {
  it('restores the exact capture-grid alt frame while the target grid is unknown', async () => {
    const terminal = new Terminal({ cols: 12, rows: 5, scrollback: 20 })
    const snapshot = {
      data: '\x1b[1;1HTOP---------\x1b[2;1HMIDDLE------\x1b[3;1HBOTTOM------',
      frameRestoreAnsi: '\x1b[?25l',
      alternateScreen: true,
      scrollbackAnsi: 'history'
    }

    try {
      const skipAltFrame = shouldSkipAltFrameForWidthMismatch(12, undefined)
      for (const chunk of buildMainModelSnapshotReplayWrites(snapshot, {
        skipAltFrame,
        paneOnAlternateScreen: false
      })) {
        await writeTerminal(terminal, chunk)
      }

      expect(
        Array.from({ length: 3 }, (_, row) =>
          terminal.buffer.active.getLine(row)?.translateToString(true)
        )
      ).toEqual(['TOP---------', 'MIDDLE------', 'BOTTOM------'])
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('history')
    } finally {
      terminal.dispose()
    }
  })

  it('keeps normal history and a clean alt grid through the real resize path', async () => {
    const terminal = new Terminal({ cols: 12, rows: 5, scrollback: 20 })
    const snapshot = {
      data: '\x1b[1;1HWIDE-FRAME',
      frameRestoreAnsi: '\x1b[?25l',
      alternateScreen: true,
      scrollbackAnsi: 'log'
    }

    try {
      for (const chunk of buildMainModelSnapshotReplayWrites(snapshot, {
        skipAltFrame: true,
        paneOnAlternateScreen: false
      })) {
        await writeTerminal(terminal, chunk)
      }
      terminal.resize(4, 5)

      expect(terminal.buffer.active.type).toBe('alternate')
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('')
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('log')
    } finally {
      terminal.dispose()
    }
  })

  it('drops only the frame paint, keeping scrollback and the alt-buffer choreography', () => {
    expect(
      buildMainModelSnapshotReplayWrites(
        {
          data: 'mode-prefixalt-frame',
          frameRestoreAnsi: 'complete-live-state',
          alternateScreen: true,
          scrollbackAnsi: 'normal-history'
        },
        { skipAltFrame: true, paneOnAlternateScreen: false }
      )
    ).toEqual([
      NORMAL_BUFFER_PROLOGUE,
      'normal-history',
      buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: false }),
      'complete-live-state'
    ])
  })

  it('still enters a cleared alt screen when skipping without split scrollback', () => {
    // Why the clear still runs: the caller's SIGWINCH must land on a clean
    // screen the application repaints, not the stale pre-park frame.
    expect(
      buildMainModelSnapshotReplayWrites(
        {
          data: 'mode-prefixalt-frame',
          frameRestoreAnsi: 'complete-live-state',
          alternateScreen: true
        },
        { skipAltFrame: true, paneOnAlternateScreen: false }
      )
    ).toEqual([ALT_BUFFER_PROLOGUE, 'complete-live-state'])
  })

  it('keeps composed data when an older producer omits the mode boundary', () => {
    expect(
      buildMainModelSnapshotReplayWrites(
        { data: 'legacy-modes-and-frame', alternateScreen: true },
        { skipAltFrame: true, paneOnAlternateScreen: false }
      )
    ).toEqual([ALT_BUFFER_PROLOGUE, 'legacy-modes-and-frame'])
  })

  it('never drops a normal-buffer snapshot, whose rows reflow correctly', () => {
    expect(
      buildMainModelSnapshotReplayWrites(
        { data: 'shell-output' },
        { skipAltFrame: true, paneOnAlternateScreen: false }
      )
    ).toEqual([NORMAL_BUFFER_PROLOGUE, 'shell-output'])
  })

  // STA-4042: a replay only runs because renderer-bound bytes were dropped, so
  // the pen that the drop interrupted is unknown. Every branch must clear it
  // BEFORE replaying content, or the whole restored buffer inherits it — the
  // "regular text renders bold" field report.
  it('clears the SGR pen before any replayed content in every branch', () => {
    // Each built for a pane that genuinely has to switch, so there is a switch
    // to bracket; when the pane is already on target no switch is emitted and
    // there is nothing for restoreCursor to undo.
    const branches = [
      buildMainModelSnapshotReplayWrites(
        { data: 'normal-buffer' },
        { paneOnAlternateScreen: true }
      ),
      buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true, scrollbackAnsi: 'scrollback' },
        { paneOnAlternateScreen: true }
      ),
      buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true },
        { paneOnAlternateScreen: false }
      )
    ]
    for (const writes of branches) {
      // CAN leads, so a truncated control string is aborted rather than
      // committed by the first ESC that follows.
      expect(writes[0].startsWith('\x18')).toBe(true)
      // Literal bytes, not the imported constant: asserting the constant against
      // itself would pass for any value it happened to hold.
      const prologue = writes[0]
      expect(prologue).toContain('\x1b[0m') // SGR
      expect(prologue).toContain('\x0f\x1b(B') // GL -> G0, G0 -> ASCII
      expect(prologue).toContain('\x1b[r') // margins
      expect(prologue.endsWith('\x1b7')).toBe(true) // saved-cursor floor, last
      // The baseline brackets the buffer switch: once before, so `?1049h` banks
      // grounded state rather than the gap's, and once after, so `?1049l`'s
      // restore cannot reapply the old register over it.
      const switchAt = prologue.indexOf('\x1b[?1049')
      expect(switchAt).toBeGreaterThanOrEqual(0)
      expect(prologue.indexOf('\x1b[0m')).toBeLessThan(switchAt)
      expect(prologue.lastIndexOf('\x1b[0m')).toBeGreaterThan(switchAt)
      // Nothing may be replayed ahead of the first prologue.
      expect(writes.indexOf('scrollback')).not.toBe(0)
    }
  })
})
