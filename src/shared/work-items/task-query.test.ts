import { expect, it } from 'vitest'
import { parseTaskQuery, stripRepoQualifiers, withQualifier } from './task-query'

it('round-trips labels containing a mid-word apostrophe', () => {
  const query = withQualifier('is:pr', 'labels', ["won't-fix", 'bug'])
  expect(parseTaskQuery(query).labels).toEqual(["won't-fix", 'bug'])
  expect(parseTaskQuery("don't is:open").state).toBe('open')
})

it('removes repo filters without turning quoted search text into filters', () => {
  const query = stripRepoQualifiers(
    'repo:owner/project "repo:literal/name" "is:closed" label:"help wanted" REPO:"other/project"'
  )
  expect(query).toBe('"repo:literal/name" "is:closed" label:"help wanted"')
  expect(parseTaskQuery(query).state).toBeNull()
  // GitHub search only honors double-quoted phrases.
  expect(stripRepoQualifiers("'tab bar' -label:'needs triage' repo:a/b")).toBe(
    '"tab bar" -label:"needs triage"'
  )
  // The tokenizer cannot escape " inside "...", so mixed-quoted phrases keep their raw quoting.
  const mixedQuotes = `'a" is:closed "b' label:'x" is:merged "y'`
  const mixedQuery = stripRepoQualifiers(`repo:o/p ${mixedQuotes}`)
  expect(mixedQuery).toBe(mixedQuotes)
  expect(parseTaskQuery(mixedQuery)).toMatchObject({ state: null, labels: ['x" is:merged "y'] })
})
