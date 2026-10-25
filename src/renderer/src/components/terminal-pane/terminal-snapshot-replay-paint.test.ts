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
// Already-alt snapshots must work without incidental ?1049h side effects.
const ALT_BUFFER_PROLOGUE_FROM_ALT = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: true })}`

function readRows(terminal: Terminal, count: number): (string | undefined)[] {
  return Array.from({ length: count }, (_, row) =>
    terminal.buffer.active.getLine(row)?.translateToString(true)
  )
}

describe('RESET_AFTER_BYTE_GAP', () => {
  // Use the real emulator to prove post-gap cells cannot inherit a stranded pen (STA-4042).
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

  // CAN aborts truncated OSC/DCS/APC; bare ESC would commit a partial title or clipboard write instead.
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

// Use production-shaped snapshot composition so dirty and clean renderers converge, including split history/alt payloads and absolute-cursor epilogues.
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
        // Seed saved cursor so snapshot generation actually exercises its absolute-cursor epilogue.
        await writeToTerminal(
          model.terminal,
          `${enterAlt}\x1b[2;5H\x1b7\x1b[33mONE\r\nplain two\r\n\x1b[1mbold three`
        )
        const snapshot = buildParityMainBufferSnapshot(model, 1)
        expect(snapshot.alternateScreen).toBe(alternateScreen)
        // Require production split-alt shape and cursor epilogue to avoid vacuous branch coverage.
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

// SerializeAddon assumes default cells and emits no charset; stranded state would silently rewrite replayed content.
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

  // Exercise production split-alt snapshot output, the reported STA-4042 branch.
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

  // ?1049l restores saved pen/charsets/modes; grounding before the switch alone would be undone and restore bold bleed.
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

  // Poison the saved register’s pen, G-sets, GL, origin, wrap and cursor; post-switch grounding must neutralize all restored state.
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

  // Replay must adopt model buffer state or missed alt exit leaves Kitty flags leaking into an unnegotiated shell.
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

  // Ground before ?1049h too: otherwise it banks stale pen/charsets that only reappear when the TUI later exits.
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

  // Avoid same-buffer ?1049: xterm still swaps Kitty registers even without a buffer swap, confiscating a live agent’s flags.
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

  // Snapshot only re-emits enabled reverse wrap; explicitly clear stranded on state before later backspace crosses a soft wrap.
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

  // Production alt payloads contain their own ?1049h and can bank Kitty flags; this checks only that the prologue adds no unnecessary switch.
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

  // Ground outgoing normal-buffer margins too; buffer-local stale regions otherwise return when the TUI exits alt.
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

  // Preserve G1–G3: SO/SI terminfo designates G1 once at initialization and snapshot replay never redeclares it, so resetting breaks live box drawing.
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

  // Trailing DECSC overwrites a stale saved cursor register before a live TUI’s later ESC 8 can restore gap state.
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

  // Serialized exact-width rows need autowrap; stranded-off mode overwrites the margin and loses history.
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

  // Origin mode can look correct during replay with reset margins yet break later TUI cursor addressing; explicitly clear it.
  it('leaves origin mode off so later cursor addressing stays absolute', async () => {
    const terminal = new Terminal({ cols: 10, rows: 6, allowProposedApi: true })
    try {
      // Already-alt replay has no buffer restore to repair state incidentally; only baseline reset can do it.
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

  // Cleared frames hide stranded insert mode; later in-place repaint exposes shifts unless explicitly grounded.
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

  // Cover already-alt separately: no normal-buffer restore incidentally clears saved origin/autowrap state.
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

  // Already-alt ?1049h keeps buffer-local margins; explicit reset must clear them.
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

  // A missed TUI exit leaves renderer on alt; restore onto normal so history stays scrollable and survives later switches.
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

  // Infinity passes a simple > 0 check; malformed dimensions must never reach terminal.resize.
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

  // Main strips alt entry from split payloads; the restorer must rebuild normal history then return to alt before painting the frame.
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
    // Still clear before SIGWINCH so application repaint cannot inherit the pre-park frame.
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

  // Unknown gap state must be grounded before any replay branch paints content (STA-4042).
  it('clears the SGR pen before any replayed content in every branch', () => {
    // Use genuine buffer transitions so baseline ordering around switch/restore is exercised.
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
      // Leading CAN aborts a truncated control string instead of committing it on the next ESC.
      expect(writes[0].startsWith('\x18')).toBe(true)
      // Assert literal protocol bytes so a broken imported constant cannot satisfy its own test.
      const prologue = writes[0]
      expect(prologue).toContain('\x1b[0m') // SGR
      expect(prologue).toContain('\x0f\x1b(B') // GL -> G0, G0 -> ASCII
      expect(prologue).toContain('\x1b[r') // margins
      expect(prologue.endsWith('\x1b7')).toBe(true) // saved-cursor floor, last
      // Ground before switching to save clean state and after switching to override restored stale state.
      const switchAt = prologue.indexOf('\x1b[?1049')
      expect(switchAt).toBeGreaterThanOrEqual(0)
      expect(prologue.indexOf('\x1b[0m')).toBeLessThan(switchAt)
      expect(prologue.lastIndexOf('\x1b[0m')).toBeGreaterThan(switchAt)
      // Nothing may be replayed ahead of the first prologue.
      expect(writes.indexOf('scrollback')).not.toBe(0)
    }
  })
})
