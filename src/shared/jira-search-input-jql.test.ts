import { describe, expect, it } from 'vitest'
import { buildJiraTextSearchJql, mayBeJql } from './jira-search-input-jql'

describe('mayBeJql', () => {
  it.each([
    'project = ABC AND statusCategory != Done',
    'summary ~ login',
    'summary !~ login',
    'created >= -7d',
    'created < -1w',
    'status in (Open, "In Progress")',
    'priority NOT IN (Low)',
    'assignee is EMPTY',
    'fixVersion IS NOT null',
    'status WAS Done',
    'status WAS NOT IN (Done)',
    'assignee CHANGED',
    'ORDER BY updated DESC',
    '"Custom field" = "value"',
    'cf[12345] >= 10',
    'issueFunction in linkedIssuesOf("project = ABC")',
    'NOT (status = Done OR assignee IS EMPTY)',
    // Prose with operator words still reaches Jira; its answer decides.
    'value is null',
    'this is broken'
  ])('sends input that could parse as JQL to Jira: %s', (input) => {
    expect(mayBeJql(input)).toBe(true)
  })

  it.each([
    's',
    'test',
    'fix login bug',
    'ABC-12',
    'within isolation',
    'order the pizza',
    'sign-in page',
    'built-in was-',
    '   '
  ])('skips JQL for input with no operator: %s', (input) => {
    expect(mayBeJql(input)).toBe(false)
  })
})

describe('buildJiraTextSearchJql', () => {
  it.each([
    ['s', 'text ~ "s*"'],
    ['  Fix Login  ', 'text ~ "fix login*"'],
    ['abc-12', 'key = "ABC-12"'],
    ["don't break", 'text ~ "don\'t break*"']
  ])('%s -> %s', (input, expected) => {
    expect(buildJiraTextSearchJql(input)).toBe(expected)
  })

  // Each of these returned HTTP 400 or zero results from Jira before being neutralized.
  it.each([
    ['fix (login', 'text ~ "fix login*"'],
    ['fix login)', 'text ~ "fix login*"'],
    ['say "hi', 'text ~ "say hi*"'],
    ['say "hi" \\ bye', 'text ~ "say hi bye*"'],
    ['foo [bar', 'text ~ "foo bar*"'],
    ['{x', 'text ~ "x*"'],
    ['^boost', 'text ~ "boost*"'],
    ['login -', 'text ~ "login*"'],
    ['fix &&', 'text ~ "fix*"'],
    ['foo ||', 'text ~ "foo*"'],
    ['a:b', 'text ~ "a b*"'],
    ['C++ build', 'text ~ "c build*"'],
    ['what?', 'text ~ "what*"']
  ])('treats search syntax in %s as plain text', (input, expected) => {
    expect(buildJiraTextSearchJql(input)).toBe(expected)
  })

  // Jira skips word-splitting for a wildcard term, so each of these matched nothing with a trailing *.
  it.each([
    ['fix login.', 'text ~ "fix login."'],
    ['login,', 'text ~ "login,"'],
    ['C#', 'text ~ "c#"'],
    ['100%', 'text ~ "100%"'],
    ['$5', 'text ~ "$5"'],
    ['a;b', 'text ~ "a;b"'],
    ['foo=bar', 'text ~ "foo=bar"'],
    ['node.js', 'text ~ "node.js"']
  ])('drops the wildcard when the last word has punctuation: %s', (input, expected) => {
    expect(buildJiraTextSearchJql(input)).toBe(expected)
  })

  it.each([
    ['café', 'text ~ "café*"'],
    ["don't", 'text ~ "don\'t*"'],
    ['login. fix', 'text ~ "login. fix*"']
  ])('keeps the wildcard on a plain last word: %s', (input, expected) => {
    expect(buildJiraTextSearchJql(input)).toBe(expected)
  })

  it.each([
    ['OR x', 'text ~ "or x*"'],
    ['AND x', 'text ~ "and x*"'],
    ['fix NOT login', 'text ~ "fix not login*"']
  ])('keeps boolean words as words: %s', (input, expected) => {
    expect(buildJiraTextSearchJql(input)).toBe(expected)
  })

  it.each(['', '   ', '(', '"', '()[]{}', '&& ||'])(
    'returns nothing searchable for %j',
    (input) => {
      expect(buildJiraTextSearchJql(input)).toBe('')
    }
  )
})
