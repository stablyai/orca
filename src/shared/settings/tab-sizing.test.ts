import { describe, expect, it } from 'vitest'
import { normalizeTabSizing } from './tab-sizing'

describe('normalizeTabSizing', () => {
  it('reads missing settings from older profiles as the current auto layout', () => {
    expect(normalizeTabSizing(undefined)).toEqual({ mode: 'auto', minWidth: 144, maxWidth: 300 })
  })

  it('falls back to auto for a mode written by a newer peer', () => {
    expect(normalizeTabSizing({ tabSizing: 'compact' }).mode).toBe('auto')
  })

  it('clamps widths into range and never lets max fall below min', () => {
    expect(normalizeTabSizing({ tabSizingMinWidth: 10, tabSizingMaxWidth: 5000 })).toEqual({
      mode: 'auto',
      minWidth: 60,
      maxWidth: 800
    })
    expect(normalizeTabSizing({ tabSizingMinWidth: 240, tabSizingMaxWidth: 120 })).toEqual({
      mode: 'auto',
      minWidth: 240,
      maxWidth: 240
    })
  })
})
