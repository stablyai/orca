import { expect, it } from 'vitest'
import { parseTaskQuery, withQualifier } from './task-query'

it('round-trips labels containing a mid-word apostrophe', () => {
  const query = withQualifier('is:pr', 'labels', ["won't-fix", 'bug'])
  expect(parseTaskQuery(query).labels).toEqual(["won't-fix", 'bug'])
  expect(parseTaskQuery("don't is:open").state).toBe('open')
})
