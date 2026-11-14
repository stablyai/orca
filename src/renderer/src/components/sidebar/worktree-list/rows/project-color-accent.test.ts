import { describe, expect, it } from 'vitest'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../../../shared/constants'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import {
  getProjectColorAccentHeaderTintStyle,
  getProjectColorAccentRailStyle,
  getProjectColorAccentRailLeft,
  isProjectColorAccentsEnabled,
  resolveProjectColorAccent
} from './project-color-accent'

const repo = { badgeColor: '#22c55e' }

describe('resolveProjectColorAccent', () => {
  it('uses the badge color for rows under a project header', () => {
    expect(
      resolveProjectColorAccent({ enabled: true, groupBy: 'repo', sectionKey: 'repo:a', repo })
    ).toBe('#22c55e')
  })

  it('draws nothing while the setting is off', () => {
    expect(
      resolveProjectColorAccent({ enabled: false, groupBy: 'repo', sectionKey: 'repo:a', repo })
    ).toBeUndefined()
  })

  it('draws nothing outside project grouping', () => {
    expect(
      resolveProjectColorAccent({
        enabled: true,
        groupBy: 'workspace-status',
        sectionKey: 'repo:a',
        repo
      })
    ).toBeUndefined()
  })

  it('leaves pinned and folder lanes uncolored because they mix projects', () => {
    for (const sectionKey of [PINNED_GROUP_KEY, 'project-group:g1']) {
      expect(
        resolveProjectColorAccent({ enabled: true, groupBy: 'repo', sectionKey, repo })
      ).toBeUndefined()
    }
  })

  it('falls back to the default badge color for an invalid stored color', () => {
    expect(
      resolveProjectColorAccent({
        enabled: true,
        groupBy: 'repo',
        sectionKey: 'repo:a',
        repo: { badgeColor: 'not-a-color' }
      })
    ).toBe(DEFAULT_REPO_BADGE_COLOR)
  })

  it('draws nothing for a row without a repo', () => {
    expect(
      resolveProjectColorAccent({
        enabled: true,
        groupBy: 'repo',
        sectionKey: 'repo:a',
        repo: undefined
      })
    ).toBeUndefined()
  })
})

describe('project color accent geometry', () => {
  it('shares one rail offset between a header and its rows at each depth', () => {
    expect(getProjectColorAccentRailLeft(0)).toBe(1)
    expect(getProjectColorAccentRailLeft(1)).toBeGreaterThan(getProjectColorAccentRailLeft(0))
    expect(getProjectColorAccentHeaderTintStyle('#22c55e', 2).left).toBe(
      getProjectColorAccentRailLeft(2)
    )
  })
})

describe('getProjectColorAccentRailStyle', () => {
  it('spans the row frame padding so consecutive rails join', () => {
    const style = getProjectColorAccentRailStyle('#22c55e', 0, { before: 12, after: 6, closing: 4 })
    expect(style.top).toBe(-12)
    expect(style.bottom).toBe(-10)
  })
})

describe('isProjectColorAccentsEnabled', () => {
  it('is opt-in', () => {
    expect(isProjectColorAccentsEnabled(undefined)).toBe(false)
    expect(isProjectColorAccentsEnabled({})).toBe(false)
    expect(isProjectColorAccentsEnabled({ sidebarProjectColorAccents: true })).toBe(true)
  })
})
