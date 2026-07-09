import { describe, expect, it } from 'vitest'
import {
  composeJiraStatusJql,
  getJiraPresetBaseJql,
  orderJiraStatusCatalog
} from './jira-preset-jql'

describe('getJiraPresetBaseJql', () => {
  it('returns the assigned preset JQL', () => {
    expect(getJiraPresetBaseJql('assigned')).toBe(
      'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
    )
  })

  it('returns the reported preset JQL', () => {
    expect(getJiraPresetBaseJql('reported')).toBe(
      'reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
    )
  })

  it('returns the done preset JQL', () => {
    expect(getJiraPresetBaseJql('done')).toBe(
      'assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC'
    )
  })

  it('returns the all preset JQL', () => {
    expect(getJiraPresetBaseJql('all')).toBe('resolution = Unresolved ORDER BY updated DESC')
  })
})

describe('composeJiraStatusJql', () => {
  it('passes through the base JQL when no statuses are selected', () => {
    const baseJql = 'project = ORCA ORDER BY updated DESC'

    expect(composeJiraStatusJql(baseJql, [])).toBe(baseJql)
  })

  it('inserts a single status before ORDER BY', () => {
    expect(composeJiraStatusJql('project = ORCA ORDER BY updated DESC', ['In Progress'])).toBe(
      'project = ORCA AND status in ("In Progress") ORDER BY updated DESC'
    )
  })

  it('inserts multiple statuses as an OR list before ORDER BY', () => {
    expect(
      composeJiraStatusJql('project = ORCA ORDER BY updated DESC', ['In Progress', 'Blocked'])
    ).toBe('project = ORCA AND status in ("In Progress", "Blocked") ORDER BY updated DESC')
  })

  it('preserves the trailing sort clause', () => {
    expect(
      composeJiraStatusJql('assignee = currentUser() ORDER BY priority DESC, updated ASC', ['Done'])
    ).toBe('assignee = currentUser() AND status in ("Done") ORDER BY priority DESC, updated ASC')
  })

  it('appends the status clause when ORDER BY is absent', () => {
    expect(composeJiraStatusJql('project = ORCA', ['To Do'])).toBe(
      'project = ORCA AND status in ("To Do")'
    )
  })

  it('escapes quotes and backslashes in status names', () => {
    expect(
      composeJiraStatusJql('project = ORCA ORDER BY updated DESC', ['Needs "QA" \\ Review'])
    ).toBe('project = ORCA AND status in ("Needs \\"QA\\" \\\\ Review") ORDER BY updated DESC')
  })

  it('uses the last ORDER BY token in the base JQL', () => {
    expect(
      composeJiraStatusJql(
        'summary ~ "write ORDER BY docs" AND project = ORCA ORDER BY updated DESC',
        ['ORDER BY Cleanup']
      )
    ).toBe(
      'summary ~ "write ORDER BY docs" AND project = ORCA AND status in ("ORDER BY Cleanup") ORDER BY updated DESC'
    )
  })
})

describe('orderJiraStatusCatalog', () => {
  it('orders statuses by category bucket and then name', () => {
    expect(
      orderJiraStatusCatalog([
        { name: 'Ready', categoryKey: 'indeterminate' },
        { name: 'Done', categoryKey: 'done' },
        { name: 'Backlog', categoryKey: 'new' },
        { name: 'Blocked', categoryKey: 'indeterminate' },
        { name: 'Archived', categoryKey: 'other' },
        { name: 'Open', categoryKey: 'new' }
      ])
    ).toEqual([
      { name: 'Backlog', categoryKey: 'new' },
      { name: 'Open', categoryKey: 'new' },
      { name: 'Blocked', categoryKey: 'indeterminate' },
      { name: 'Ready', categoryKey: 'indeterminate' },
      { name: 'Done', categoryKey: 'done' },
      { name: 'Archived', categoryKey: 'other' }
    ])
  })
})
