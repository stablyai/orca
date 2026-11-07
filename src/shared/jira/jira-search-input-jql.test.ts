import { describe, expect, it } from 'vitest'
import { buildJiraIssueKeyJql, buildJiraTextMatchJql } from './jira-search-input-jql'

describe('buildJiraTextMatchJql', () => {
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
    expect(buildJiraTextMatchJql(input)).toBe(expected)
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
    expect(buildJiraTextMatchJql(input)).toBe(expected)
  })

  it.each([
    ['café', 'text ~ "café*"'],
    ["don't", 'text ~ "don\'t*"'],
    ['login. fix', 'text ~ "login. fix*"']
  ])('keeps the wildcard on a plain last word: %s', (input, expected) => {
    expect(buildJiraTextMatchJql(input)).toBe(expected)
  })

  it.each([
    ['OR x', 'text ~ "or x*"'],
    ['AND x', 'text ~ "and x*"'],
    ['fix NOT login', 'text ~ "fix not login*"']
  ])('keeps boolean words as words: %s', (input, expected) => {
    expect(buildJiraTextMatchJql(input)).toBe(expected)
  })
})

describe('buildJiraIssueKeyJql', () => {
  it.each([
    ['400', 'key = "PROJ-400"'],
    // A full key names its own project, so the selected one must not prefix it.
    ['other-5', 'key = "OTHER-5"']
  ])('within project PROJ: %s -> %s', (input, expected) => {
    expect(buildJiraIssueKeyJql(input, ['PROJ'])).toBe(expected)
  })

  it.each([
    ['400', 'key in ("ALP-400", "BET-400")'],
    ['other-5', 'key = "OTHER-5"']
  ])('within projects ALP and BET: %s -> %s', (input, expected) => {
    expect(buildJiraIssueKeyJql(input, ['ALP', 'BET', 'alp'])).toBe(expected)
  })

  it.each(['400 crash', '#400', 'v400', '4.0'])('is not a key within a project: %j', (input) => {
    expect(buildJiraIssueKeyJql(input, ['PROJ'])).toBeNull()
  })

  it('needs a project to read a bare number as a key', () => {
    expect(buildJiraIssueKeyJql('400')).toBeNull()
  })
})
