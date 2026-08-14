import { describe, expect, it } from 'vitest'
import { jiraCurrentSprintJql, withCurrentSprintClause } from './task-page-jira-sprint-filter'

describe('jiraCurrentSprintJql', () => {
  it('appends the sprint clause to the preset query before its ORDER BY', () => {
    expect(jiraCurrentSprintJql('assigned', '')).toBe(
      'assignee = currentUser() AND resolution = Unresolved AND sprint in openSprints() ORDER BY updated DESC'
    )
  })

  it('wraps a user search query instead of the preset', () => {
    expect(jiraCurrentSprintJql('assigned', 'project = STA')).toBe(
      '(project = STA) AND sprint in openSprints()'
    )
  })
})

describe('withCurrentSprintClause', () => {
  it('keeps a trailing ORDER BY outside the sprint conjunction', () => {
    expect(withCurrentSprintClause('project = STA ORDER BY created ASC')).toBe(
      '(project = STA) AND sprint in openSprints() ORDER BY created ASC'
    )
  })

  it('handles a case-insensitive order by', () => {
    expect(withCurrentSprintClause('project = STA order by created ASC')).toBe(
      '(project = STA) AND sprint in openSprints() order by created ASC'
    )
  })

  it('leaves a bare ORDER BY query untouched', () => {
    expect(withCurrentSprintClause(' ORDER BY created ASC')).toBe(' ORDER BY created ASC')
  })
})
