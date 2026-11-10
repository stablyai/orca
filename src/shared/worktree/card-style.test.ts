import { describe, expect, it } from 'vitest'
import { getWorktreeCardStyle, worktreeCardStyleSettingsUpdate } from './card-style'

describe('getWorktreeCardStyle', () => {
  it('maps the legacy boolean when the style was never written', () => {
    expect(getWorktreeCardStyle({ experimentalNewWorktreeCardStyle: true })).toBe('experimental-1')
    expect(getWorktreeCardStyle({ experimentalNewWorktreeCardStyle: false })).toBe('classic')
    expect(getWorktreeCardStyle({})).toBe('classic')
    expect(getWorktreeCardStyle(null)).toBe('classic')
  })

  it('round-trips every style through the paired settings update', () => {
    for (const style of ['classic', 'experimental-1'] as const) {
      expect(getWorktreeCardStyle(worktreeCardStyleSettingsUpdate(style))).toBe(style)
    }
  })

  it('reads the retired second experimental card as the experimental card', () => {
    expect(
      getWorktreeCardStyle({
        worktreeCardStyle: 'experimental-2',
        experimentalNewWorktreeCardStyle: true
      })
    ).toBe('experimental-1')
  })

  it('lets an older client that only flips the boolean win', () => {
    expect(
      getWorktreeCardStyle({
        worktreeCardStyle: 'experimental-2',
        experimentalNewWorktreeCardStyle: false
      })
    ).toBe('classic')
    expect(
      getWorktreeCardStyle({
        worktreeCardStyle: 'classic',
        experimentalNewWorktreeCardStyle: true
      })
    ).toBe('experimental-1')
  })
})
