import { describe, expect, it } from 'vitest'
import { captureTerminalArchiveBuffer } from './terminal-archive-snapshot-capture'

describe('captureTerminalArchiveBuffer', () => {
  it('accepts only a non-truncated empty buffer as a proven empty capture', () => {
    expect(captureTerminalArchiveBuffer({ buffer: '', source: 'renderer' })).toEqual({
      kind: 'captured-empty'
    })
    expect(
      captureTerminalArchiveBuffer({ buffer: '', source: 'relay-tail', truncated: true })
    ).toEqual({ kind: 'unavailable' })
  })

  it('preserves bounded data provenance for a non-empty capture', () => {
    expect(
      captureTerminalArchiveBuffer({ buffer: 'hello', source: 'daemon-headless', truncated: true })
    ).toEqual({
      kind: 'captured-bytes',
      buffer: 'hello',
      source: 'daemon-headless',
      truncated: true,
      byteLength: 5
    })
  })
})
