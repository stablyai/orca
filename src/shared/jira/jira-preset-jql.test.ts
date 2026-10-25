import { describe, expect, it } from 'vitest'
import { buildJiraPresetJql } from './jira-preset-jql'
import { normalizeJiraQuickFilterState } from './jira-quick-filters'
import { JiraIssueListFiltersParam } from '../rpc-contract/jira-quick-filter-params'

describe('Jira preset status predicates', () => {
  it.each([
    ['assigned', 'assignee = currentUser() AND statusCategory != Done'],
    ['reported', 'reporter = currentUser() AND statusCategory != Done'],
    ['all', 'statusCategory != Done'],
    ['done', 'assignee = currentUser() AND statusCategory = Done']
  ] as const)('preserves %s scope and combines statuses with OR', (preset, base) => {
    expect(buildJiraPresetJql(preset)).toBe(`${base} ORDER BY updated DESC`)
    expect(buildJiraPresetJql(preset, { statuses: ['Blocked', 'In Progress'] })).toBe(
      `${base} AND status in ("Blocked", "In Progress") ORDER BY updated DESC`
    )
  })
  it('escapes quoted status names without treating ORDER BY as syntax', () => {
    expect(
      buildJiraPresetJql('all', { statuses: ['Needs "QA" \\ Review', 'ORDER BY cleanup'] })
    ).toBe(
      'statusCategory != Done AND status in ("Needs \\"QA\\" \\\\ Review", "ORDER BY cleanup") ORDER BY updated DESC'
    )
  })
  it('bounds persisted state while preserving actual status names', () => {
    expect(
      normalizeJiraQuickFilterState({
        statuses: [' In Progress ', 'Done', 'Done', 42, '', 'x'.repeat(129)]
      })
    ).toEqual({ statuses: [' In Progress ', 'Done'] })
    expect(normalizeJiraQuickFilterState(null)).toEqual({ statuses: [] })
    expect(
      JiraIssueListFiltersParam.safeParse({ statuses: Array.from({ length: 51 }, () => 'Open') })
        .success
    ).toBe(false)
    expect(JiraIssueListFiltersParam.safeParse({ statuses: ['   '] }).success).toBe(false)
  })
})
