import { describe, expect, it } from 'vitest'
import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { resolveProjectGroupHeaderColor, resolveRepoHeaderColor } from './project-header-color'

describe('resolveRepoHeaderColor', () => {
  it('returns a canonical palette color', () => {
    expect(resolveRepoHeaderColor(REPO_COLORS[3])).toBe(REPO_COLORS[3])
  })

  it('keeps the default repo badge color gray', () => {
    expect(resolveRepoHeaderColor(DEFAULT_REPO_BADGE_COLOR)).toBe(DEFAULT_REPO_BADGE_COLOR)
  })

  it.each([undefined, null, ''])('falls back for missing or empty input: %s', (badgeColor) => {
    expect(resolveRepoHeaderColor(badgeColor)).toBe(DEFAULT_REPO_BADGE_COLOR)
  })

  it('normalizes whitespace and casing to the canonical palette value', () => {
    expect(resolveRepoHeaderColor(`  ${REPO_COLORS[4].toUpperCase()}  `)).toBe(REPO_COLORS[4])
  })

  it('returns normalized custom hex colors', () => {
    expect(resolveRepoHeaderColor(' #123ABC ')).toBe('#123abc')
  })

  it('falls back for invalid colors', () => {
    expect(resolveRepoHeaderColor('blue')).toBe(DEFAULT_REPO_BADGE_COLOR)
  })
})

describe('resolveProjectGroupHeaderColor', () => {
  it('returns the repo color for project group headers', () => {
    expect(
      resolveProjectGroupHeaderColor({
        groupBy: 'repo',
        headerKey: 'repo:repo-1',
        badgeColor: REPO_COLORS[5]
      })
    ).toBe(REPO_COLORS[5])
  })

  it('falls back to gray for unknown project group headers', () => {
    expect(
      resolveProjectGroupHeaderColor({
        groupBy: 'repo',
        headerKey: 'repo:missing-repo',
        badgeColor: undefined
      })
    ).toBe(DEFAULT_REPO_BADGE_COLOR)
  })

  it('does not color pinned headers while grouped by repo', () => {
    expect(
      resolveProjectGroupHeaderColor({
        groupBy: 'repo',
        headerKey: 'pinned',
        badgeColor: undefined
      })
    ).toBeUndefined()
  })

  it('does not color repo-looking keys in other grouping modes', () => {
    expect(
      resolveProjectGroupHeaderColor({
        groupBy: 'workspace-status',
        headerKey: 'repo:repo-1',
        badgeColor: REPO_COLORS[2]
      })
    ).toBeUndefined()
  })
})
