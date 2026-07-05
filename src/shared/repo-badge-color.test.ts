import { describe, expect, it } from 'vitest'
import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from './constants'
import {
  normalizeRepoBadgeColor,
  pickRoundRobinRepoBadgeColor,
  resolveRepoBadgeColor
} from './repo-badge-color'

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

describe('round-robin repo badge color selection', () => {
  const nonDefaultPalette = REPO_COLORS.slice(1)

  it('starts with the first non-gray palette color', () => {
    expect(pickRoundRobinRepoBadgeColor(0)).toBe('#ef4444')
  })

  it('cycles through all non-gray palette colors', () => {
    expect(
      Array.from({ length: nonDefaultPalette.length }, (_, count) =>
        pickRoundRobinRepoBadgeColor(count)
      )
    ).toEqual(['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#8b5cf6', '#ec4899'])
  })

  it('wraps after the non-gray palette', () => {
    expect(pickRoundRobinRepoBadgeColor(nonDefaultPalette.length)).toBe('#ef4444')
  })

  it('never returns the gray default color', () => {
    for (let count = 0; count < nonDefaultPalette.length * 3; count += 1) {
      expect(pickRoundRobinRepoBadgeColor(count)).not.toBe(DEFAULT_REPO_BADGE_COLOR)
    }
  })

  it('wraps negative counts into the non-gray palette', () => {
    expect(pickRoundRobinRepoBadgeColor(-1)).toBe('#ec4899')
  })
})
