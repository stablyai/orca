import { describe, expect, it } from 'vitest'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  readProposedTerminalCols,
  resolvePositiveTerminalDimensions,
  selectDaemonSnapshotReplayData
} from './terminal-snapshot-replay-paint'

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

describe('readProposedTerminalCols', () => {
  it('returns a measurable proposed width and degrades safely', () => {
    expect(
      readProposedTerminalCols({ fitAddon: { proposeDimensions: () => ({ cols: 90, rows: 30 }) } })
    ).toBe(90)
    expect(readProposedTerminalCols({ fitAddon: { proposeDimensions: () => undefined } })).toBe(
      undefined
    )
    expect(
      readProposedTerminalCols({
        fitAddon: {
          proposeDimensions: () => {
            throw new Error('unmeasurable')
          }
        }
      })
    ).toBe(undefined)
  })
})

describe('selectDaemonSnapshotReplayData', () => {
  const snapshot = 'PREFIX-ALT-FRAME'
  const base = {
    snapshot,
    snapshotFrameStart: 7,
    snapshotCols: 140,
    targetCols: 80,
    isAlternateScreen: true
  }

  it('drops only a wider live alternate-screen frame', () => {
    expect(selectDaemonSnapshotReplayData(base)).toBe('PREFIX-')
  })

  it('keeps equal, narrower, normal-screen, and cold-restore frames', () => {
    expect(selectDaemonSnapshotReplayData({ ...base, targetCols: 140 })).toBe(snapshot)
    expect(selectDaemonSnapshotReplayData({ ...base, targetCols: 160 })).toBe(snapshot)
    expect(selectDaemonSnapshotReplayData({ ...base, isAlternateScreen: false })).toBe(snapshot)
    expect(selectDaemonSnapshotReplayData({ ...base, coldRestore: true })).toBe(snapshot)
  })

  it.each([undefined, -1, 0, 7.5, snapshot.length, snapshot.length + 1])(
    'keeps the merged snapshot for boundary %s',
    (snapshotFrameStart) => {
      expect(selectDaemonSnapshotReplayData({ ...base, snapshotFrameStart })).toBe(snapshot)
    }
  )

  it.each([
    { snapshotCols: undefined, targetCols: 80 },
    { snapshotCols: 140, targetCols: undefined },
    { snapshotCols: Number.NaN, targetCols: 80 },
    { snapshotCols: 140, targetCols: Number.POSITIVE_INFINITY },
    { snapshotCols: 0, targetCols: 80 },
    { snapshotCols: 140, targetCols: 0 }
  ])('keeps the merged snapshot for invalid widths %#', (widths) => {
    expect(selectDaemonSnapshotReplayData({ ...base, ...widths })).toBe(snapshot)
  })
})

describe('buildMainModelSnapshotReplayWrites', () => {
  it('clears normal buffer + scrollback before a normal-buffer snapshot', () => {
    expect(buildMainModelSnapshotReplayWrites({ data: 'shell-output' })).toEqual([
      '\x1b[2J\x1b[3J\x1b[H',
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
      '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H',
      'normal-history',
      '\x1b[0m\x1b[?1049h\x1b[2J\x1b[H',
      'alt-frame'
    ])
  })

  it('enters a cleared alt screen when no split scrollback is available', () => {
    expect(
      buildMainModelSnapshotReplayWrites({ data: 'alt-frame', alternateScreen: true })
    ).toEqual(['\x1b[0m\x1b[?1049h\x1b[2J\x1b[H', 'alt-frame'])
  })
})
