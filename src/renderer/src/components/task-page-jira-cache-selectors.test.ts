import { describe, expect, it } from 'vitest'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { JiraIssue } from '../../../shared/types'
import { findTaskPageJiraIssue } from './task-page-jira-cache-selectors'

function jiraSourceContext(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'jira',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'jira',
      siteId: 'site-1'
    }
  }
}

function jiraIssue(key: string, title: string, siteId = 'site-1'): JiraIssue {
  return {
    id: `${siteId}:${key}`,
    key,
    title,
    url: `https://example.atlassian.net/browse/${key}`,
    siteId,
    siteName: 'Example Jira',
    project: { id: '10000', key: 'ALP', name: 'Alpha', siteId },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: '1', name: 'Todo', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('findTaskPageJiraIssue', () => {
  it('keeps same-key Jira issues separated by source context', () => {
    const localSource = jiraSourceContext('local-runtime')
    const remoteSource = jiraSourceContext('remote-runtime')
    const localScope = getTaskSourceCacheScope(localSource)
    const remoteScope = getTaskSourceCacheScope(remoteSource)

    const found = findTaskPageJiraIssue(
      {
        [`${localScope}::site-1::ALP-1`]: {
          data: jiraIssue('ALP-1', 'Local issue'),
          fetchedAt: Date.now()
        }
      },
      {
        [`${remoteScope}::site-1::list::assigned::30`]: {
          data: [jiraIssue('ALP-1', 'Remote issue')],
          fetchedAt: Date.now()
        }
      },
      'ALP-1',
      {
        sourceContext: remoteSource,
        siteId: 'site-1'
      }
    )

    expect(found?.title).toBe('Remote issue')
  })

  it('filters same-key Jira issues by site id', () => {
    const source = jiraSourceContext('remote-runtime')
    const scope = getTaskSourceCacheScope(source)

    const found = findTaskPageJiraIssue(
      {},
      {
        [`${scope}::site-1::list::assigned::30`]: {
          data: [jiraIssue('ALP-1', 'Site one issue', 'site-1')],
          fetchedAt: Date.now()
        },
        [`${scope}::site-2::list::assigned::30`]: {
          data: [jiraIssue('ALP-1', 'Site two issue', 'site-2')],
          fetchedAt: Date.now()
        }
      },
      'ALP-1',
      {
        sourceContext: source,
        siteId: 'site-2'
      }
    )

    expect(found?.title).toBe('Site two issue')
  })
})
