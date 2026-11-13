import { describe, expect, it } from 'vitest'
import { buildJiraPresetJql } from './jira-preset-jql'
import { normalizeJiraQuickFilterState } from './jira-quick-filters'

describe('Jira preset status predicates', () => {
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
  })
})
