import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalInlineImageCacheMb,
  TERMINAL_INLINE_IMAGE_CACHE_MB_PRESETS
} from './terminal-inline-image-cache-policy'

describe('terminal inline image cache policy', () => {
  it('falls back to the 32 MB default for missing or non-numeric input', () => {
    expect(normalizeTerminalInlineImageCacheMb(undefined)).toBe(32)
    expect(normalizeTerminalInlineImageCacheMb(null)).toBe(32)
    expect(normalizeTerminalInlineImageCacheMb('128')).toBe(32)
    expect(normalizeTerminalInlineImageCacheMb(Number.NaN)).toBe(32)
    expect(normalizeTerminalInlineImageCacheMb(Number.POSITIVE_INFINITY)).toBe(32)
  })

  it('floors fractional values and clamps to the supported range', () => {
    expect(normalizeTerminalInlineImageCacheMb(64.9)).toBe(64)
    expect(normalizeTerminalInlineImageCacheMb(0)).toBe(8)
    expect(normalizeTerminalInlineImageCacheMb(-5)).toBe(8)
    expect(normalizeTerminalInlineImageCacheMb(4_096)).toBe(512)
  })

  it('keeps every preset unchanged', () => {
    for (const preset of TERMINAL_INLINE_IMAGE_CACHE_MB_PRESETS) {
      expect(normalizeTerminalInlineImageCacheMb(preset)).toBe(preset)
    }
  })
})
