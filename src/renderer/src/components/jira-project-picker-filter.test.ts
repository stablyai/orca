import { describe, expect, it } from 'vitest'
import type { JiraProject } from '../../../shared/types'
import {
  JIRA_PROJECT_PICKER_QUERY_MAX_BYTES,
  filterJiraProjectPickerProjects,
  getJiraProjectPickerDisplayLabel,
  isJiraProjectPickerQueryTooLarge
} from './jira-project-picker-filter'

function project(overrides: Partial<JiraProject> = {}): JiraProject {
  return {
    id: '10000',
    key: 'APP',
    name: 'Application',
    siteId: 'site-1',
    siteName: 'Engineering',
    ...overrides
  }
}

describe('jira-project-picker-filter', () => {
  it('formats project labels with optional site names', () => {
    const candidate = project()

    expect(getJiraProjectPickerDisplayLabel(candidate, true)).toBe(
      'Engineering · Application (APP)'
    )
    expect(getJiraProjectPickerDisplayLabel(candidate, false)).toBe('Application (APP)')
  })

  it('matches project labels, keys, names, and site names', () => {
    const projects = [
      project({ id: '1', key: 'APP', name: 'Application', siteName: 'Engineering' }),
      project({ id: '2', key: 'OPS', name: 'Operations', siteName: 'Support' })
    ]

    expect(
      filterJiraProjectPickerProjects({
        projects,
        query: 'ops',
        includeSiteName: true
      })
    ).toEqual([projects[1]])
    expect(
      filterJiraProjectPickerProjects({
        projects,
        query: 'engineering',
        includeSiteName: true
      })
    ).toEqual([projects[0]])
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(JIRA_PROJECT_PICKER_QUERY_MAX_BYTES)

    expect(query.length).toBe(JIRA_PROJECT_PICKER_QUERY_MAX_BYTES)
    expect(isJiraProjectPickerQueryTooLarge(query)).toBe(true)
    expect(
      filterJiraProjectPickerProjects({
        projects: [project()],
        query,
        includeSiteName: true
      })
    ).toEqual([])
  })

  it('rejects oversized pasted project queries before reading project metadata', () => {
    const oversizedQuery = 'secret-jira-project-query'.repeat(JIRA_PROJECT_PICKER_QUERY_MAX_BYTES)
    const candidate = {
      get name(): string {
        throw new Error('oversized Jira project queries must not scan names')
      },
      get key(): string {
        throw new Error('oversized Jira project queries must not scan keys')
      },
      get siteName(): string {
        throw new Error('oversized Jira project queries must not scan site names')
      }
    } as JiraProject

    expect(isJiraProjectPickerQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      filterJiraProjectPickerProjects({
        projects: [candidate],
        query: oversizedQuery,
        includeSiteName: true
      })
    ).toEqual([])
  })

  it('rejects oversized whitespace before trimming project queries', () => {
    expect(
      filterJiraProjectPickerProjects({
        projects: [project()],
        query: ' '.repeat(JIRA_PROJECT_PICKER_QUERY_MAX_BYTES + 1),
        includeSiteName: true
      })
    ).toEqual([])
  })
})
