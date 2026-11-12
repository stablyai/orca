import { describe, expect, it } from 'vitest'
import type { JiraProject } from '../../../shared/jira/jira-types'
import {
  JIRA_PROJECT_PICKER_QUERY_MAX_BYTES,
  filterJiraProjectPickerProjects
} from './jira-project-picker-filter'

describe('jira-project-picker-filter', () => {
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
})
