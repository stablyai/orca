import { describe, expect, it } from 'vitest'
import { withCurrentSprintClause } from './jira-jql-predicate'

describe('withCurrentSprintClause', () => {
  it('preserves OR precedence and the requested sort', () => {
    expect(withCurrentSprintClause('project = ABC OR project = DEF ORDER BY updated DESC')).toBe(
      '(project = ABC OR project = DEF) AND sprint in openSprints() ORDER BY updated DESC'
    )
  })

  it('does not interpret ORDER BY inside quoted values as a sort', () => {
    expect(withCurrentSprintClause('summary ~ "order by title"')).toBe(
      '(summary ~ "order by title") AND sprint in openSprints()'
    )
    expect(withCurrentSprintClause("summary ~ 'order by title' order by created ASC")).toBe(
      "(summary ~ 'order by title') AND sprint in openSprints() order by created ASC"
    )
  })

  it('handles escaped quotes before a real sort', () => {
    const query = String.raw`summary ~ "say \"order by title\"" ORDER BY created ASC`
    expect(withCurrentSprintClause(query)).toBe(
      String.raw`(summary ~ "say \"order by title\"") AND sprint in openSprints() ORDER BY created ASC`
    )
  })

  it('adds sprint filtering to a sort-only query', () => {
    expect(withCurrentSprintClause('ORDER BY updated DESC')).toBe(
      'sprint in openSprints() ORDER BY updated DESC'
    )
  })
})
