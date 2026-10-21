import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { bindJiraIssueSourceContext } from './use-jira-url-source'
import { resolveWorkItemSourceRow } from './work-item-source-selection'

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project',
  hostId: 'ssh:box',
  repoId: null,
  providerIdentity: null,
  accountLabel: null
}
const site: JiraSite = {
  id: 'site',
  siteUrl: 'https://company.atlassian.net',
  email: 'account@example.com',
  displayName: 'Account',
  accountId: 'account'
}
const issue: JiraIssue = {
  id: 'issue',
  key: 'ENG-1',
  title: 'Issue',
  url: `${site.siteUrl}/browse/ENG-1`,
  siteId: site.id,
  project: { id: 'project', key: 'ENG', name: 'Engineering' },
  issueType: { id: 'bug', name: 'Bug' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To do' },
  labels: [],
  updatedAt: '',
  createdAt: ''
}
const contexts = { github: null, gitlab: null, linear: null, jira: source }

describe('shared work-item source resolution', () => {
  it('binds a known Jira account for both creation and attachment selection', () => {
    expect(
      resolveWorkItemSourceRow({ kind: 'jira', value: 'jira', issue }, contexts, [site])
        ?.taskSourceContext
    ).toEqual(bindJiraIssueSourceContext(source, site, issue))
  })
  it('rejects a row whose account is no longer available', () => {
    expect(
      resolveWorkItemSourceRow({ kind: 'jira', value: 'jira', issue }, contexts, [])
    ).toBeNull()
  })
  it.each([{ siteId: 'another-account' }, { url: 'https://other.atlassian.net/browse/ENG-1' }])(
    'rejects a pre-bound account that does not match the result: %j',
    (overrides) => {
      const bound = bindJiraIssueSourceContext(source, site, issue)
      expect(
        resolveWorkItemSourceRow(
          { kind: 'jira', value: 'jira', issue: { ...issue, ...overrides } },
          { ...contexts, jira: bound }
        )
      ).toBeNull()
    }
  )
  it('accepts the callback-bound account when no connection list is available', () => {
    const bound = bindJiraIssueSourceContext(source, site, issue)
    expect(
      resolveWorkItemSourceRow({ kind: 'jira', value: 'jira', issue }, { ...contexts, jira: bound })
        ?.taskSourceContext
    ).toEqual(bound)
  })
})
