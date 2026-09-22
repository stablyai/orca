import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { bindTaskPageJiraItemSourceContext } from './task-page-jira-item-source-context'

const SOURCE_CONTEXT: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'runtime:env-1'
}

const SITES: JiraSite[] = [
  {
    id: 'site-a',
    siteUrl: 'https://a.atlassian.net',
    email: 'a@example.com',
    displayName: 'Site A',
    accountId: 'account-a'
  },
  {
    id: 'site-b',
    siteUrl: 'https://b.atlassian.net/jira',
    email: 'b@example.com',
    displayName: 'Site B',
    accountId: 'account-b'
  }
]

const ISSUE = {
  key: 'ORCA-123',
  siteId: 'site-b',
  project: { key: 'ORCA' }
} as JiraIssue

describe('TaskPage Jira item source context', () => {
  it('binds an All-sites result to its originating Jira site and project', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: ISSUE,
        sites: SITES,
        sourceContext: SOURCE_CONTEXT
      })
    ).toMatchObject({
      hostId: 'runtime:env-1',
      accountLabel: 'b@example.com',
      providerIdentity: {
        provider: 'jira',
        siteId: 'site-b',
        siteUrl: 'https://b.atlassian.net/jira',
        projectKey: 'ORCA'
      }
    })
  })

  it('refuses to bind an issue whose originating site is unavailable', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: { ...ISSUE, siteId: 'missing' },
        sites: SITES,
        sourceContext: SOURCE_CONTEXT
      })
    ).toBeNull()
  })
})
