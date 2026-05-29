import { describe, expect, it } from 'vitest'
import { DEFAULT_REPO_BADGE_COLOR } from './constants'
import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from './repo-badge-color'

describe('repo badge color normalization', () => {
  it('normalizes six-digit hex colors', () => {
    expect(normalizeRepoBadgeColor(' ABCDEF ')).toBe('#abcdef')
    expect(normalizeRepoBadgeColor('#ABCDEF')).toBe('#abcdef')
  })

  it('expands shorthand hex colors', () => {
    expect(normalizeRepoBadgeColor('#abc')).toBe('#aabbcc')
  })

  it('rejects non-hex colors', () => {
    expect(normalizeRepoBadgeColor('blue')).toBeNull()
    expect(normalizeRepoBadgeColor('url(javascript:alert(1))')).toBeNull()
    expect(normalizeRepoBadgeColor('#12zz12')).toBeNull()
  })

  it('falls back to the default repo color when resolving invalid input', () => {
    expect(resolveRepoBadgeColor('blue')).toBe(DEFAULT_REPO_BADGE_COLOR)
  })
})
