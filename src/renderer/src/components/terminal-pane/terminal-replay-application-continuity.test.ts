import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  writeToTerminal
} from '../../../../shared/terminal-restore-parity-fixture'
import { buildMainModelSnapshotReplayWrites } from './terminal-snapshot-replay-paint'

/**
 * What a LIVE application sees after its pane is restored from a main-model
 * snapshot. The sibling suite proves the restored frame is correct; this one
 * proves the replay does not confiscate state the application still owns and
 * will not re-declare.
 *
 * Grounded in real capability strings (`infocmp`), because the one regression
 * that reached review here was a terminfo family nobody had enumerated.
 */

async function replayInto(
  terminal: Terminal,
  model: ReturnType<typeof createRendererParityTerminal>,
  paneOnAlternateScreen: boolean
): Promise<void> {
  const snapshot = buildParityMainBufferSnapshot(model, 1)
  for (const write of buildMainModelSnapshotReplayWrites(snapshot, { paneOnAlternateScreen })) {
    await writeToTerminal(terminal, write)
  }
}

function row(terminal: Terminal, index: number): string {
  return terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
}

/** Text alone cannot see a stranded pen: include the attributes per cell. */
function rowWithAttributes(terminal: Terminal, index: number): string {
  const line = terminal.buffer.active.getLine(index)
  if (!line) {
    return ''
  }
  const cells: string[] = []
  for (let column = 0; column < line.length; column++) {
    const cell = line.getCell(column)
    if (!cell) {
      continue
    }
    cells.push(
      `${cell.getChars()}|${cell.isBold() ? 'b' : ''}${cell.isInverse() ? 'i' : ''}${cell.getFgColor()}`
    )
  }
  return cells.join(',')
}

describe('line-drawing survives a replay for every real terminfo strategy', () => {
  // Verbatim from `infocmp`. The two families differ in who owns the
  // designation: xterm/alacritty re-designate G0 on every smacs, so they
  // self-heal; the SO/SI family designates G1 once via enacs and never again.
  const acsStrategies = [
    { term: 'xterm-256color', enacs: '', smacs: '\x1b(0', rmacs: '\x1b(B' },
    { term: 'alacritty', enacs: '', smacs: '\x1b(0', rmacs: '\x1b(B' },
    { term: 'screen-256color', enacs: '\x1b(B\x1b)0', smacs: '\x0e', rmacs: '\x0f' },
    { term: 'tmux-256color', enacs: '\x1b(B\x1b)0', smacs: '\x0e', rmacs: '\x0f' },
    { term: 'vt100', enacs: '\x1b(B\x1b)0', smacs: '\x0e', rmacs: '\x0f' },
    { term: 'linux', enacs: '\x1b)0', smacs: '\x0e', rmacs: '\x0f' }
  ] as const

  for (const { term, enacs, smacs, rmacs } of acsStrategies) {
    it(`draws a box after a normal-buffer replay under ${term}`, async () => {
      const model = createRendererParityTerminal({ cols: 20, rows: 4 })
      const pane = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
      try {
        await writeToTerminal(model.terminal, 'restored output')
        // The application initialises its charsets once, before the gap.
        await writeToTerminal(pane, enacs)

        await replayInto(pane, model, false)
        await writeToTerminal(pane, `\r\n${smacs}lqqqk${rmacs}`)

        expect(row(pane, 1)).toBe('┌───┐')
      } finally {
        model.terminal.dispose()
        pane.dispose()
      }
    })

    it(`draws a box after an alt-screen replay under ${term}`, async () => {
      const model = createRendererParityTerminal({ cols: 20, rows: 4 })
      const pane = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
      try {
        await writeToTerminal(model.terminal, '\x1b[?1049hTUI FRAME')
        await writeToTerminal(pane, `\x1b[?1049h${enacs}`)

        await replayInto(pane, model, true)
        await writeToTerminal(pane, `\r\n${smacs}lqqqk${rmacs}`)

        expect(row(pane, 1)).toBe('┌───┐')
      } finally {
        model.terminal.dispose()
        pane.dispose()
      }
    })
  }

  // The gap can also strand a shift-out mid-run. GL is the one piece of charset
  // state the replay does ground, because the payload renders through it.
  it('renders the restored frame as ASCII even if the gap stranded a shift-out', async () => {
    const model = createRendererParityTerminal({ cols: 20, rows: 4 })
    const pane = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'qqq plain text')
      await writeToTerminal(pane, '\x1b(B\x1b)0\x0e')

      await replayInto(pane, model, false)

      expect(row(pane, 0)).toBe('qqq plain text')
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })
})

describe('real TUI shapes survive a replay', () => {
  // A vim-like editor: alt screen, a scroll region reserving the status line,
  // and its own saved cursor. All of it is re-declared by the model snapshot,
  // so the pane must end up matching the model rather than the gap.
  it('keeps an editor scroll region and status line after a replay', async () => {
    const model = createRendererParityTerminal({ cols: 20, rows: 6 })
    const pane = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, '\x1b[?1049h\x1b[1;5r\x1b[1;1Hline one')
      await writeToTerminal(model.terminal, '\x1b[6;1H-- INSERT --')
      // The gap left a different region and a stranded origin mode behind.
      await writeToTerminal(pane, '\x1b[?1049h\x1b[2;3r\x1b[?6h')

      await replayInto(pane, model, true)
      // Scroll INSIDE the restored region: reading the painted rows alone would
      // pass even if `1;5r` never came back, so make the region do work.
      await writeToTerminal(pane, '\x1b[5;1H\n\nscrolled')

      // Row 6 is outside the model's 1;5 region and must not have moved.
      expect(row(pane, 5)).toBe('-- INSERT --')
      expect(row(pane, 4)).toBe('scrolled')
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // A pager filling the viewport. Deliberately a NORMAL-buffer snapshot with the
  // pane already on normal, so no `?1049` is emitted at all: on the alt path the
  // split branch's `?1049l` restores saved modes and would grant autowrap back
  // for free, and the test would pass without the baseline doing anything.
  it('keeps every column of a pager frame when the gap stranded autowrap off', async () => {
    const model = createRendererParityTerminal({ cols: 10, rows: 4 })
    const pane = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'ABCDEFGHIJKLMN')
      await writeToTerminal(pane, '\x1b[?7l')

      await replayInto(pane, model, false)

      expect([row(pane, 0), row(pane, 1)]).toEqual(['ABCDEFGHIJ', 'KLMN'])
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // Same reasoning for insert mode: a later in-place repaint by the app must
  // overwrite, not shift. No buffer switch, so the baseline is the only source.
  it('keeps a live repaint overwriting when the gap stranded insert mode', async () => {
    const model = createRendererParityTerminal({ cols: 12, rows: 3 })
    const pane = new Terminal({ cols: 12, rows: 3, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'OLDTEXT')
      await writeToTerminal(pane, '\x1b[4h')

      await replayInto(pane, model, false)
      await writeToTerminal(pane, '\x1b[1;1HNEW')

      expect(row(pane, 0)).toBe('NEWTEXT')
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // And reverse wraparound, which only manifests through a later backspace.
  it('keeps a live backspace from chewing the row above after a replay', async () => {
    const model = createRendererParityTerminal({ cols: 8, rows: 3 })
    const pane = new Terminal({ cols: 8, rows: 3, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'AAAAAAAABBBB')
      await writeToTerminal(pane, '\x1b[?45h')

      await replayInto(pane, model, false)
      await writeToTerminal(pane, '\b\b\b\b\bX')

      expect([row(pane, 0), row(pane, 1)]).toEqual(['AAAAAAAA', 'XBBB'])
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // An agent that negotiated the kitty keyboard protocol keeps it: the pane is
  // already on the buffer the snapshot describes, so nothing should switch.
  it('keeps a live agent kitty negotiation when no buffer switch is needed', async () => {
    const options = {
      cols: 20,
      rows: 4,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    }
    const readFlags = (term: Terminal): unknown => {
      const flags = (term as unknown as { _core: { coreService: { kittyKeyboard: unknown } } })
        ._core.coreService.kittyKeyboard
      expect(flags).toBeDefined()
      return flags
    }
    const model = createRendererParityTerminal({ cols: 20, rows: 4 })
    const pane = new Terminal(options)
    const untouched = new Terminal(options)
    try {
      await writeToTerminal(model.terminal, 'shell output')
      await writeToTerminal(pane, '\x1b[>1u')
      await writeToTerminal(untouched, '\x1b[>1u')

      await replayInto(pane, model, false)

      expect(readFlags(pane)).toEqual(readFlags(untouched))
    } finally {
      model.terminal.dispose()
      pane.dispose()
      untouched.dispose()
    }
  })
})

describe('repeated gap and restore cycles', () => {
  // Each restore must be idempotent: three gaps in a row should leave the pane
  // exactly where one does, with no state accumulating across the prologues.
  it('converges on the same frame after three successive restores', async () => {
    const model = createRendererParityTerminal({ cols: 20, rows: 4 })
    const once = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    const thrice = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    // Attributes and a mode-sensitive operation, not just text: stranded bold,
    // margins and autowrap are all invisible to a text-only comparison.
    const describeFrame = async (terminal: Terminal): Promise<string> => {
      await writeToTerminal(terminal, '\x1b[3;1Hzz\bY')
      return JSON.stringify({
        type: terminal.buffer.active.type,
        rows: [0, 1, 2, 3].map((index) => rowWithAttributes(terminal, index)),
        cursor: [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]
      })
    }
    try {
      await writeToTerminal(model.terminal, '\x1b[?1049hframe body')

      await replayInto(once, model, false)
      for (let cycle = 0; cycle < 3; cycle++) {
        // A fresh gap strands new state before each restore.
        await writeToTerminal(thrice, '\x1b[1m\x1b[2;3r\x1b[?7l\x1b]0;TRUNC')
        // Only the first restore starts from the normal buffer.
        await replayInto(thrice, model, cycle !== 0)
      }

      expect(await describeFrame(thrice)).toBe(await describeFrame(once))
    } finally {
      model.terminal.dispose()
      once.dispose()
      thrice.dispose()
    }
  })
})

describe('content fidelity through a replay', () => {
  // Wide glyphs, combining sequences and an exact-width wrap are where a
  // mis-grounded autowrap or insert mode shows up as lost or shifted cells.
  const payloads = [
    { label: 'CJK wide glyphs', body: '日本語テキスト' },
    { label: 'emoji with ZWJ', body: 'a👩‍💻b' },
    { label: 'exact-width wrap', body: 'ABCDEFGHIJKLMNOPQRST' },
    { label: 'combining marks', body: 'ééé' }
  ] as const

  for (const { label, body } of payloads) {
    it(`replays ${label} identically into a gap-dirtied pane`, async () => {
      const model = createRendererParityTerminal({ cols: 20, rows: 4 })
      const clean = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
      const dirty = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
      try {
        await writeToTerminal(model.terminal, body)
        await replayInto(clean, model, false)

        await writeToTerminal(dirty, '\x1b[1m\x1b(0\x1b[2;3r\x1b[?7l\x1b[4h\x1b7')
        await replayInto(dirty, model, false)

        expect([0, 1, 2, 3].map((index) => rowWithAttributes(dirty, index))).toEqual(
          [0, 1, 2, 3].map((index) => rowWithAttributes(clean, index))
        )
      } finally {
        model.terminal.dispose()
        clean.dispose()
        dirty.dispose()
      }
    })
  }
})
