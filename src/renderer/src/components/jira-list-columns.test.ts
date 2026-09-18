import { describe, expect, it } from 'vitest'
import {
  JIRA_LIST_COLUMNS,
  defaultJiraListColumnIds,
  formatJiraEstimate,
  jiraListGridTemplate,
  resolveJiraListColumnIds,
  visibleJiraListColumns
} from './jira-list-columns'

describe('jira list columns', () => {
  it('defaults to the classic columns with the agile ones hidden', () => {
    expect([...defaultJiraListColumnIds()]).toEqual([
      'key',
      'title',
      'status',
      'priority',
      'assignee',
      'updated'
    ])
  })

  it('restores saved columns, drops unknown ids and re-adds locked ones', () => {
    const ids = resolveJiraListColumnIds(['sprint', 'storyPoints', 'bogus'])
    expect([...ids].sort()).toEqual(['key', 'sprint', 'storyPoints', 'title'])
    expect([...resolveJiraListColumnIds('nope')]).toEqual([...defaultJiraListColumnIds()])
  })

  it('builds the grid template in catalog order plus the actions column', () => {
    const columns = visibleJiraListColumns(new Set(['title', 'key', 'sprint']))
    expect(columns.map((column) => column.id)).toEqual(['key', 'title', 'sprint'])
    expect(jiraListGridTemplate(columns)).toBe('96px minmax(180px,1.5fr) minmax(80px,110px) 64px')
    expect(JIRA_LIST_COLUMNS.filter((column) => column.locked).map((c) => c.id)).toEqual([
      'key',
      'title'
    ])
  })

  it('formats estimates with Jira working time', () => {
    expect(formatJiraEstimate(undefined)).toBe('–')
    expect(formatJiraEstimate(45 * 60)).toBe('45m')
    expect(formatJiraEstimate(10 * 3600)).toBe('1d 2h')
    expect(formatJiraEstimate(40 * 3600 + 30 * 60)).toBe('1w 30m')
  })
})
