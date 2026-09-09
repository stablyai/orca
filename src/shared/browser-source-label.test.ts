import { describe, expect, it } from 'vitest'
import { browserSourceLabel } from './browser-source-label'

describe('browserSourceLabel', () => {
  it('prefers a per-entry sourceLabel (distinguishes custom browsers)', () => {
    expect(
      browserSourceLabel({ browserFamily: 'custom', sourceLabel: 'Aside', importedAt: 0 })
    ).toBe('Aside')
  })

  it('falls back to the family label map when there is no sourceLabel', () => {
    expect(browserSourceLabel({ browserFamily: 'chrome', importedAt: 0 })).toBe('Google Chrome')
  })

  it('maps a bare custom family to the generic "Custom" fallback', () => {
    expect(browserSourceLabel({ browserFamily: 'custom', importedAt: 0 })).toBe('Custom')
  })
})
