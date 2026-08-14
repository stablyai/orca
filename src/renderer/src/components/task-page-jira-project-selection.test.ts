import { describe, expect, it } from 'vitest'

import {
  compareJiraProjectsByDisplayLabel,
  getJiraProjectSelectionKey
} from './task-page-jira-project-selection'
import type { JiraProject } from '../../../shared/jira-types'

function project(overrides: Partial<JiraProject> = {}): JiraProject {
  return { id: '1', key: 'AA', name: 'Alpha', ...overrides }
}

describe('getJiraProjectSelectionKey', () => {
  it('qualifies the project id with its site id', () => {
    expect(getJiraProjectSelectionKey(project({ id: '10', siteId: 'site-1' }))).toBe('site-1:10')
  })

  it('falls back to the "selected" site sentinel when siteId is absent', () => {
    expect(getJiraProjectSelectionKey(project({ id: '10' }))).toBe('selected:10')
  })

  it('treats an empty siteId as a real site id', () => {
    // characterization: current behavior — `??` only replaces null/undefined, so an
    // empty siteId produces a leading-colon key.
    expect(getJiraProjectSelectionKey(project({ id: '10', siteId: '' }))).toBe(':10')
  })
})

describe('compareJiraProjectsByDisplayLabel', () => {
  const sortOf = (projects: JiraProject[], includeSiteName: boolean): string[] =>
    [...projects]
      .sort((a, b) => compareJiraProjectsByDisplayLabel(a, b, includeSiteName))
      .map((entry) => `${entry.siteName ?? ''}/${entry.name}/${entry.key}`)

  it('orders by site name first when site names are included', () => {
    const projects = [
      project({ name: 'Alpha', key: 'AA', siteName: 'Zeta' }),
      project({ name: 'Beta', key: 'BB', siteName: 'Acme' })
    ]
    expect(sortOf(projects, true)).toEqual(['Acme/Beta/BB', 'Zeta/Alpha/AA'])
  })

  it('ignores site name when it is not included', () => {
    const projects = [
      project({ name: 'Alpha', key: 'AA', siteName: 'Zeta' }),
      project({ name: 'Beta', key: 'BB', siteName: 'Acme' })
    ]
    expect(sortOf(projects, false)).toEqual(['Zeta/Alpha/AA', 'Acme/Beta/BB'])
  })

  it('falls back to project name, then project key', () => {
    const projects = [
      project({ name: 'Alpha', key: 'AB' }),
      project({ name: 'Alpha', key: 'AA' }),
      project({ name: 'Beta', key: 'BA' })
    ]
    expect(sortOf(projects, false)).toEqual(['/Alpha/AA', '/Alpha/AB', '/Beta/BA'])
  })

  it('sorts numeric segments naturally and case-insensitively', () => {
    const projects = [project({ name: 'Team 10', key: 'A' }), project({ name: 'team 2', key: 'B' })]
    expect(sortOf(projects, false)).toEqual(['/team 2/B', '/Team 10/A'])
  })

  it('returns 0 for projects with identical display labels', () => {
    expect(compareJiraProjectsByDisplayLabel(project(), project({ id: '2' }), true)).toBe(0)
  })

  it('treats a missing site name as an empty string when comparing sites', () => {
    const withSite = project({ name: 'Zeta', key: 'ZZ', siteName: 'Acme' })
    const withoutSite = project({ name: 'Alpha', key: 'AA' })
    expect(sortOf([withSite, withoutSite], true)).toEqual(['/Alpha/AA', 'Acme/Zeta/ZZ'])
  })
})
