import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { RESET_AFTER_BYTE_GAP } from '../../../../shared/terminal-mode-reset-profiles'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  resolvePositiveTerminalDimensions,
  shouldSkipAltFrameForWidthMismatch
} from './terminal-snapshot-replay-paint'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('RESET_AFTER_BYTE_GAP', () => {
  // Real emulator rather than a mock: the guarantee is that a cell written after
  // the gap reset carries none of the pen the gap stranded (STA-4042). Scoped to
  // SGR — see RESET_AFTER_BYTE_GAP for why the wider grounding was dropped.
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
    expect(buildMainModelSnapshotReplayWrites({ data: 'shell-output' })).toEqual([
      `${RESET_AFTER_BYTE_GAP}\x1b[2J\x1b[3J\x1b[H`,
      'shell-output'
    ])
  })

  // Why: main strips the ?1049h marker when splitting scrollbackAnsi from an
  // alt frame, so the restorer must own the ?1049l rebuild + ?1049h return —
  // painting the composed bytes after a plain clear leaves the TUI frame on
  // the normal buffer.
  it('rebuilds normal buffer then paints a clean alt frame for alt-screen snapshots', () => {
    expect(
      buildMainModelSnapshotReplayWrites({
        data: 'alt-frame',
        alternateScreen: true,
        scrollbackAnsi: 'normal-history'
      })
    ).toEqual([
      `${RESET_AFTER_BYTE_GAP}\x1b[?1049l\x1b[2J\x1b[3J\x1b[H`,
      'normal-history',
      `${RESET_AFTER_BYTE_GAP}\x1b[?1049h\x1b[2J\x1b[H`,
      'alt-frame'
    ])
  })

  it('enters a cleared alt screen when no split scrollback is available', () => {
    expect(
      buildMainModelSnapshotReplayWrites({ data: 'alt-frame', alternateScreen: true })
    ).toEqual([`${RESET_AFTER_BYTE_GAP}\x1b[?1049h\x1b[2J\x1b[H`, 'alt-frame'])
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
      for (const chunk of buildMainModelSnapshotReplayWrites(snapshot, { skipAltFrame })) {
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
      for (const chunk of buildMainModelSnapshotReplayWrites(snapshot, { skipAltFrame: true })) {
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
        { skipAltFrame: true }
      )
    ).toEqual([
      `${RESET_AFTER_BYTE_GAP}\x1b[?1049l\x1b[2J\x1b[3J\x1b[H`,
      'normal-history',
      `${RESET_AFTER_BYTE_GAP}\x1b[?1049h\x1b[2J\x1b[H`,
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
        { skipAltFrame: true }
      )
    ).toEqual([`${RESET_AFTER_BYTE_GAP}\x1b[?1049h\x1b[2J\x1b[H`, 'complete-live-state'])
  })

  it('keeps composed data when an older producer omits the mode boundary', () => {
    expect(
      buildMainModelSnapshotReplayWrites(
        { data: 'legacy-modes-and-frame', alternateScreen: true },
        { skipAltFrame: true }
      )
    ).toEqual([`${RESET_AFTER_BYTE_GAP}\x1b[?1049h\x1b[2J\x1b[H`, 'legacy-modes-and-frame'])
  })

  it('never drops a normal-buffer snapshot, whose rows reflow correctly', () => {
    expect(
      buildMainModelSnapshotReplayWrites({ data: 'shell-output' }, { skipAltFrame: true })
    ).toEqual([`${RESET_AFTER_BYTE_GAP}\x1b[2J\x1b[3J\x1b[H`, 'shell-output'])
  })

  // STA-4042: a replay only runs because renderer-bound bytes were dropped, so
  // the pen that the drop interrupted is unknown. Every branch must clear it
  // BEFORE replaying content, or the whole restored buffer inherits it — the
  // "regular text renders bold" field report.
  it('clears the SGR pen before any replayed content in every branch', () => {
    const branches = [
      buildMainModelSnapshotReplayWrites({ data: 'normal-buffer' }),
      buildMainModelSnapshotReplayWrites({
        data: 'alt-frame',
        alternateScreen: true,
        scrollbackAnsi: 'scrollback'
      }),
      buildMainModelSnapshotReplayWrites({ data: 'alt-frame', alternateScreen: true })
    ]
    for (const writes of branches) {
      expect(writes[0].startsWith(RESET_AFTER_BYTE_GAP)).toBe(true)
      // Nothing may be replayed ahead of the first reset.
      expect(writes.indexOf('scrollback')).not.toBe(0)
    }
  })
})
