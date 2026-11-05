import { describe, expect, it } from 'vitest'
import type { JiraProject } from '../../../shared/jira/jira-types'
import {
  JIRA_PROJECT_PICKER_QUERY_MAX_BYTES,
  filterJiraProjectPickerProjects
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
  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(JIRA_PROJECT_PICKER_QUERY_MAX_BYTES)

    expect(query.length).toBe(JIRA_PROJECT_PICKER_QUERY_MAX_BYTES)
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
