import { describe, expect, it } from 'vitest'
import { buildJiraIssueKeyJql } from './jira-search-input-jql'

describe('buildJiraIssueKeyJql', () => {
  it.each([
    ['400', 'PROJ', 'key = "PROJ-400"'],
    [' 400 ', 'proj', 'key = "PROJ-400"'],
    ['OTHER-5', 'PROJ', 'key = "OTHER-5"'],
    ['9007199254740993', 'PROJ', 'key = "PROJ-9007199254740993"']
  ])('resolves %j within project %s', (input, projectKey, expected) => {
    expect(buildJiraIssueKeyJql(input, projectKey)).toBe(expected)
  })
})
