import { describe, expect, it } from 'vitest'
import {
  normalizeTabMaxWidth,
  normalizeTabWidthMode,
  TAB_MAX_WIDTH_DEFAULT_PX,
  TAB_MAX_WIDTH_MAX_PX,
  TAB_MAX_WIDTH_MIN_PX
} from './tab-width-settings'

describe('tab width settings normalization', () => {
  it('defaults unknown tab width modes to default', () => {
    expect(normalizeTabWidthMode('fit')).toBe('fit')
    expect(normalizeTabWidthMode('default')).toBe('default')
    expect(normalizeTabWidthMode('shrink')).toBe('default')
    expect(normalizeTabWidthMode(undefined)).toBe('default')
  })

  it('clamps, rounds, and falls back for persisted max tab widths', () => {
    expect(normalizeTabMaxWidth(undefined)).toBe(TAB_MAX_WIDTH_DEFAULT_PX)
    expect(normalizeTabMaxWidth(Number.NaN)).toBe(TAB_MAX_WIDTH_DEFAULT_PX)
    expect(normalizeTabMaxWidth(Number.POSITIVE_INFINITY)).toBe(TAB_MAX_WIDTH_DEFAULT_PX)
    expect(normalizeTabMaxWidth('240')).toBe(TAB_MAX_WIDTH_DEFAULT_PX)
    expect(normalizeTabMaxWidth(80)).toBe(TAB_MAX_WIDTH_MIN_PX)
    expect(normalizeTabMaxWidth(999)).toBe(TAB_MAX_WIDTH_MAX_PX)
    expect(normalizeTabMaxWidth(219.6)).toBe(220)
  })
})
