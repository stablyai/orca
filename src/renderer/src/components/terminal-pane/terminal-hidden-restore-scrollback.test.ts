import { describe, expect, it } from 'vitest'
import { resolveHiddenRestoreScrollbackRows } from './terminal-hidden-restore-scrollback'

describe('hidden terminal restore scrollback', () => {
  it('preserves configured history depth through the supported maximum', () => {
    expect(resolveHiddenRestoreScrollbackRows(10_000)).toBe(10_000)
    expect(resolveHiddenRestoreScrollbackRows(50_000)).toBe(50_000)
  })

  it('clamps malformed or oversized values with the shared desktop policy', () => {
    expect(resolveHiddenRestoreScrollbackRows(undefined)).toBe(5_000)
    expect(resolveHiddenRestoreScrollbackRows(100_000)).toBe(50_000)
  })
})
