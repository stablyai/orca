import { describe, expect, it } from 'vitest'
import { getLinkedWorkItemProvider } from './new-workspace'

describe('getLinkedWorkItemProvider', () => {
  it.each([
    [
      'explicit provider metadata',
      {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: 'ORCA-123 Fix Jira',
        url: 'https://example.atlassian.net/browse/ORCA-123',
        jiraIdentifier: 'ORCA-123'
      },
      'jira'
    ],
    [
      'Jira issue URL with no numeric issue id',
      {
        type: 'issue',
        number: 0,
        title: 'ORCA-123 Fix Jira',
        url: 'https://example.atlassian.net/browse/ORCA-123'
      },
      'jira'
    ],
    [
      'legacy Linear linked issue',
      {
        type: 'issue',
        number: 0,
        title: 'Fix Linear',
        url: 'https://linear.app/team/issue/ENG-123/fix-linear',
        linearIdentifier: 'ENG-123'
      },
      'linear'
    ]
  ] as const)('detects %s', (_label, item, provider) => {
    expect(getLinkedWorkItemProvider(item)).toBe(provider)
  })
})
