import { describe, expect, it } from 'vitest'
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROW_PRESETS,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN,
  legacyTerminalScrollbackBytesToRows,
  normalizeDesktopTerminalScrollbackRows,
  normalizeDesktopTerminalSnapshotRows
} from './terminal-scrollback-policy'

describe('terminal scrollback policy', () => {
  it('exports the desktop row defaults and presets', () => {
    expect(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT).toBe(5_000)
    expect(DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN).toBe(1_000)
    expect(DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX).toBe(50_000)
    expect(DESKTOP_TERMINAL_SCROLLBACK_ROW_PRESETS).toEqual([5_000, 10_000, 25_000, 50_000])
  })

  it('normalizes persisted desktop rows without string coercion', () => {
    expect(normalizeDesktopTerminalScrollbackRows(undefined)).toBe(5_000)
    expect(normalizeDesktopTerminalScrollbackRows('25000')).toBe(5_000)
    expect(normalizeDesktopTerminalScrollbackRows(Number.NaN)).toBe(5_000)
    expect(normalizeDesktopTerminalScrollbackRows(500.9)).toBe(1_000)
    expect(normalizeDesktopTerminalScrollbackRows(25_000.9)).toBe(25_000)
    expect(normalizeDesktopTerminalScrollbackRows(100_000)).toBe(50_000)
  })

  it('normalizes snapshot rows while preserving visible-screen-only zero', () => {
    expect(normalizeDesktopTerminalSnapshotRows(undefined)).toBeUndefined()
    expect(normalizeDesktopTerminalSnapshotRows('0')).toBeUndefined()
    expect(normalizeDesktopTerminalSnapshotRows(0)).toBe(0)
    expect(normalizeDesktopTerminalSnapshotRows(-1)).toBe(0)
    expect(normalizeDesktopTerminalSnapshotRows(25_000.9)).toBe(25_000)
    expect(normalizeDesktopTerminalSnapshotRows(100_000)).toBe(50_000)
  })

  it('migrates legacy decimal MB buckets by intent, not byte-to-row math', () => {
    expect(legacyTerminalScrollbackBytesToRows(undefined)).toBe(5_000)
    expect(legacyTerminalScrollbackBytesToRows(0)).toBe(5_000)
    expect(legacyTerminalScrollbackBytesToRows(1_000_000)).toBe(1_000)
    expect(legacyTerminalScrollbackBytesToRows(10_000_000)).toBe(5_000)
    expect(legacyTerminalScrollbackBytesToRows(25_000_000)).toBe(10_000)
    expect(legacyTerminalScrollbackBytesToRows(50_000_000)).toBe(25_000)
    expect(legacyTerminalScrollbackBytesToRows(100_000_000)).toBe(50_000)
    expect(legacyTerminalScrollbackBytesToRows(250_000_000)).toBe(50_000)
  })
})
