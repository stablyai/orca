import { describe, expect, it } from 'vitest'
import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { resolveProjectGroupHeaderColor, resolveRepoHeaderColor } from './project-header-color'

describe('resolveRepoHeaderColor', () => {
  it.each([undefined, null, ''])('falls back for missing or empty input: %s', (badgeColor) => {
    expect(resolveRepoHeaderColor(badgeColor)).toBe(DEFAULT_REPO_BADGE_COLOR)
  })
})

describe('resolveProjectGroupHeaderColor', () => {
  it('returns the repo color for a known Project header', () => {
    expect(
      resolveProjectGroupHeaderColor({
        isProjectHeader: true,
        badgeColor: REPO_COLORS[5]
      })
    ).toBe(REPO_COLORS[5])
  })

  it('falls back to gray for a Project header without a configured color', () => {
    expect(
      resolveProjectGroupHeaderColor({
        isProjectHeader: true,
        badgeColor: undefined
      })
    ).toBe(DEFAULT_REPO_BADGE_COLOR)
  })

  it('does not color a nested Status or PR header beneath a Project', () => {
    expect(
      resolveProjectGroupHeaderColor({
        isProjectHeader: false,
        badgeColor: REPO_COLORS[2]
      })
    ).toBeUndefined()
  })
})
