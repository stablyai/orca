import { describe, expect, it } from 'vitest'
import { getLinkedWorkItemProvider, isRepoScopedLinkedWorkItem } from './new-workspace'

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

describe('isRepoScopedLinkedWorkItem', () => {
  it.each([
    [
      'GitHub issue',
      {
        type: 'issue',
        provider: 'github',
        number: 42,
        title: 'Fix crash',
        url: 'https://github.com/acme/app/issues/42'
      },
      true
    ],
    [
      'GitLab merge request',
      {
        type: 'mr',
        number: 7,
        title: 'Add feature',
        url: 'https://gitlab.example.com/acme/app/-/merge_requests/7'
      },
      true
    ],
    [
      'Jira issue with explicit provider',
      {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: 'ORCA-123 Fix Jira',
        url: 'https://example.atlassian.net/browse/ORCA-123',
        jiraIdentifier: 'ORCA-123'
      },
      false
    ],
    [
      'Jira issue detected from URL only',
      {
        type: 'issue',
        number: 0,
        title: 'ORCA-123 Fix Jira',
        url: 'https://example.atlassian.net/browse/ORCA-123'
      },
      false
    ],
    [
      'legacy Linear issue without provider metadata',
      {
        type: 'issue',
        number: 0,
        title: 'Fix Linear',
        url: 'https://linear.app/team/issue/ENG-123/fix-linear',
        linearIdentifier: 'ENG-123'
      },
      false
    ]
  ] as const)('classifies %s', (_label, item, repoScoped) => {
    expect(isRepoScopedLinkedWorkItem(item)).toBe(repoScoped)
  })
})
