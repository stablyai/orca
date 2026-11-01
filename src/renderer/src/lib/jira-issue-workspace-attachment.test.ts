import { describe, expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { JiraIssue, JiraSite } from '../../../shared/jira/jira-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  buildJiraIssueWorkspaceAttachmentIndex,
  collectLinkedJiraIssueRefs,
  findJiraIssueWorkspaceAttachmentsInIndex
} from './jira-issue-workspace-attachment'

const site: JiraSite = {
  id: 'site-a',
  siteUrl: 'https://jira.example/jira',
  email: '',
  displayName: 'Acme',
  accountId: 'user'
}
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-a',
  hostId: 'local',
  accountLabel: 'Acme',
  providerIdentity: { provider: 'jira', siteId: 'site-a', siteUrl: site.siteUrl, projectKey: 'APP' }
}
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix',
  url: `${site.siteUrl}/browse/APP-1`,
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
function linked(id: string, overrides: Partial<Worktree> = {}) {
  return makeWorktree({
    id,
    repoId: 'repo',
    linkedItems: [
      {
        provider: 'jira',
        type: 'issue',
        number: 0,
        identifier: 'app-1',
        url: issue.url,
        taskSourceContext: source
      }
    ],
    ...overrides
  })
}
function matches(workspaces: ReturnType<typeof makeWorktree>[], target = issue, context = source) {
  return findJiraIssueWorkspaceAttachmentsInIndex(
    buildJiraIssueWorkspaceAttachmentIndex(workspaces),
    target,
    context
  )
}
describe('Jira workspace attachment identity', () => {
  it('finds every workspace across repositories and puts recent activity first', () => {
    const first = linked('api', { repoId: 'api', lastActivityAt: 1 })
    const second = linked('web', { repoId: 'web', lastActivityAt: 2 })
    expect(matches([first, second])).toEqual([second, first])
  })
  it('reads secondary attachments, not only the selected legacy link', () => {
    const workspace = linked('secondary')
    workspace.linkedWorkItem = {
      provider: 'github',
      type: 'issue',
      number: 42,
      title: 'Selected',
      url: 'https://github.com/acme/api/issues/42'
    }
    expect(matches([workspace])).toEqual([workspace])
  })
  it('includes folder and SSH workspaces when their Jira source is the desktop', () => {
    const folder = linked('folder:docs', { repoId: '', branch: '', hostId: 'ssh:builder' })
    expect(matches([folder])).toEqual([folder])
  })
  it('excludes archived workspaces and deduplicates attachment keys in a workspace', () => {
    const workspace = linked('live')
    workspace.linkedItems?.push({
      provider: 'jira',
      type: 'issue',
      number: 0,
      jiraIdentifier: 'APP-1',
      url: issue.url
    })
    expect(matches([linked('archived', { isArchived: true }), workspace])).toEqual([workspace])
  })
  it('rejects identifier collisions on another site, context path, or project', () => {
    const workspace = linked('same-key')
    expect(
      matches([workspace], {
        ...issue,
        siteId: 'site-b',
        url: 'https://other.example/browse/APP-1'
      })
    ).toEqual([])
    expect(
      matches([workspace], { ...issue, url: 'https://jira.example/other/browse/APP-1' })
    ).toEqual([])
    expect(matches([workspace], { ...issue, project: { ...issue.project, key: 'OTHER' } })).toEqual(
      []
    )
  })
  it('rejects another execution host or Jira account but allows other repo contexts', () => {
    const workspace = linked('same-key')
    expect(matches([workspace], issue, { ...source, hostId: 'runtime:cloud' })).toEqual([])
    // Another login on the same site has its own siteId, and its issues carry it.
    const otherSite: JiraSite = { ...site, id: 'site-a2', accountId: 'other-user' }
    const otherLogin: TaskSourceContext = {
      ...source,
      providerIdentity: { provider: 'jira', siteId: otherSite.id, siteUrl: site.siteUrl }
    }
    expect(matches([workspace], { ...issue, siteId: otherSite.id }, otherLogin)).toEqual([])
    expect(
      collectLinkedJiraIssueRefs([workspace], [site, otherSite], otherSite.id, otherLogin)
    ).toEqual([])
    expect(
      matches([workspace], issue, { ...source, projectId: 'other-repo-project', repoId: 'other' })
    ).toEqual([workspace])
  })
  it('requires proven site identity for old key-only links', () => {
    const bare = makeWorktree({
      id: 'bare',
      repoId: 'repo',
      linkedItems: [{ provider: 'jira', type: 'issue', number: 0, jiraIdentifier: 'APP-1' }]
    })
    expect(matches([bare])).toEqual([])
    const legacy = makeWorktree({
      id: 'legacy',
      repoId: 'repo',
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        jiraIdentifier: 'APP-1',
        title: 'Fix',
        url: issue.url
      }
    })
    expect(matches([legacy])).toEqual([legacy])
  })
  it('matches links whose account label differs from the Tasks page label', () => {
    const emailLabeled = makeWorktree({
      id: 'email-labeled',
      repoId: 'repo',
      linkedItems: [
        {
          provider: 'jira',
          type: 'issue',
          number: 0,
          identifier: 'APP-1',
          url: issue.url,
          taskSourceContext: { ...source, accountLabel: 'dev@acme.example' }
        }
      ]
    })
    const tasksPage = { ...source, accountLabel: 'Acme' }
    expect(matches([emailLabeled], issue, tasksPage)).toEqual([emailLabeled])
    expect(collectLinkedJiraIssueRefs([emailLabeled], [site], 'all', tasksPage)).toMatchObject([
      { key: 'APP-1', siteId: site.id }
    ])
  })
  it('matches account-scoped links in the all-sites view', () => {
    expect(matches([linked('one')], issue, { ...source, accountLabel: null })).toHaveLength(1)
  })

  it('collects each linked issue once, respects selected site and drops foreign sources', () => {
    const refs = collectLinkedJiraIssueRefs(
      [linked('one'), linked('two'), linked('archived', { isArchived: true })],
      [site],
      'all',
      source
    )
    expect(refs).toMatchObject([{ key: 'APP-1', siteId: site.id, sourceContext: source }])
    expect(collectLinkedJiraIssueRefs([linked('one')], [site], 'site-b', source)).toEqual([])
    expect(
      collectLinkedJiraIssueRefs([linked('one')], [site], 'all', {
        ...source,
        hostId: 'runtime:cloud'
      })
    ).toEqual([])
  })
})
