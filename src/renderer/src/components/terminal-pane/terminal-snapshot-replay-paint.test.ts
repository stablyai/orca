import { describe, expect, it } from 'vitest'
import {
  buildMainModelSnapshotReplayWrites,
  hasPositiveTerminalDimensions,
  resolvePositiveTerminalDimensions
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
