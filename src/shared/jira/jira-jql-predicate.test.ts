import { expect, it } from 'vitest'
import { hasJiraJqlOrderBy } from './jira-jql-predicate'

it('detects only a top-level ORDER BY clause', () => {
  expect(hasJiraJqlOrderBy('status = "To Do" AND assignee = empty ORDER BY Rank')).toBe(true)
  expect(hasJiraJqlOrderBy('order by created DESC')).toBe(true)
  expect(hasJiraJqlOrderBy('summary ~ "order by" AND project = ABC')).toBe(false)
  expect(hasJiraJqlOrderBy('labels in ("order by") AND key = ABC-1')).toBe(false)
  expect(hasJiraJqlOrderBy('project = ABC AND reorder = 1')).toBe(false)
})
