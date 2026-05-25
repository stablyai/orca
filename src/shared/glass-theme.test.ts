import { describe, expect, it } from 'vitest'
import { isGlassTheme } from './glass-theme'

describe('isGlassTheme', () => {
  it('returns true for glass-light', () => {
    expect(isGlassTheme('glass-light')).toBe(true)
  })

  it('returns true for glass-dark', () => {
    expect(isGlassTheme('glass-dark')).toBe(true)
  })

  it('returns false for plain dark / light / system', () => {
    expect(isGlassTheme('dark')).toBe(false)
    expect(isGlassTheme('light')).toBe(false)
    expect(isGlassTheme('system')).toBe(false)
  })

  it('returns false for undefined / null', () => {
    expect(isGlassTheme(undefined)).toBe(false)
    expect(isGlassTheme(null)).toBe(false)
  })

  it('narrows the type via the type guard', () => {
    const t: 'system' | 'dark' | 'light' | 'glass-light' | 'glass-dark' = 'glass-dark'
    if (isGlassTheme(t)) {
      // Type narrowing: t is 'glass-light' | 'glass-dark' inside this branch
      const narrowed: 'glass-light' | 'glass-dark' = t
      expect(narrowed).toBe('glass-dark')
    }
  })
})
