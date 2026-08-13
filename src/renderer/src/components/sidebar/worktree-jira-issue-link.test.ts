import { describe, expect, it } from 'vitest'
import {
  buildJiraLinkedWorkItem,
  resolveJiraIssueLink,
  selectJiraSiteForLink,
  type ParsedJiraIssueLink
} from './worktree-jira-issue-link'
import type { JiraConnectionStatus, JiraIssue, JiraSite } from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

const site = (id: string, siteUrl: string): JiraSite => ({ id, siteUrl }) as JiraSite

function status(sites: JiraSite[], activeSiteId: string | null = null): JiraConnectionStatus {
  return { connected: sites.length > 0, viewer: null, sites, activeSiteId }
}

const bareKey: ParsedJiraIssueLink = { provider: 'jira', issueKey: 'PROJ-9' }
const pinnedUrl: ParsedJiraIssueLink = {
  provider: 'jira',
  issueKey: 'PROJ-9',
  siteOrigin: 'https://acme.atlassian.net',
  sitePath: ''
}

const context = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'p1',
  hostId: 'local'
} as unknown as TaskSourceContext

const issue = (key: string): JiraIssue =>
  ({
    key,
    title: `Ticket ${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    project: { key: 'PROJ' }
  }) as JiraIssue

describe('selectJiraSiteForLink', () => {
  it('reports not-connected when the status is disconnected or has no sites', () => {
    expect(selectJiraSiteForLink(bareKey, status([]))).toEqual({ errorKind: 'not-connected' })
    expect(
      selectJiraSiteForLink(bareKey, { connected: false, viewer: null, sites: [site('1', 'x')] })
    ).toEqual({ errorKind: 'not-connected' })
  })

  it('pins the site a URL names by exact origin', () => {
    const resolved = selectJiraSiteForLink(
      pinnedUrl,
      status([site('1', 'https://acme.atlassian.net'), site('2', 'https://other.atlassian.net')])
    )
    expect(resolved).toEqual({ site: site('1', 'https://acme.atlassian.net') })
  })

  it('does not match a host that merely starts with the pinned origin', () => {
    const resolved = selectJiraSiteForLink(
      pinnedUrl,
      status([site('1', 'https://acme.atlassian.net.evil.example')])
    )
    expect(resolved).toEqual({ errorKind: 'site-not-connected' })
  })

  it('uses the active site for a bare key', () => {
    const resolved = selectJiraSiteForLink(
      bareKey,
      status(
        [site('1', 'https://acme.atlassian.net'), site('2', 'https://other.atlassian.net')],
        '2'
      )
    )
    expect(resolved).toEqual({ site: site('2', 'https://other.atlassian.net') })
  })

  it('uses the only connected site for a bare key when none is active', () => {
    expect(
      selectJiraSiteForLink(bareKey, status([site('1', 'https://acme.atlassian.net')]))
    ).toEqual({ site: site('1', 'https://acme.atlassian.net') })
  })

  it('refuses to guess when several sites are connected and none is active', () => {
    const resolved = selectJiraSiteForLink(
      bareKey,
      status([site('1', 'https://acme.atlassian.net'), site('2', 'https://other.atlassian.net')])
    )
    expect(resolved).toEqual({ errorKind: 'ambiguous-site' })
  })
})

describe('buildJiraLinkedWorkItem', () => {
  it('stores the identifier in the Jira field and zeroes the numeric one', () => {
    expect(buildJiraLinkedWorkItem(issue('PROJ-9'))).toEqual({
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'Ticket PROJ-9',
      url: 'https://acme.atlassian.net/browse/PROJ-9',
      jiraIdentifier: 'PROJ-9'
    })
  })
})

describe('resolveJiraIssueLink', () => {
  it('resolves a bare key against the active site', async () => {
    const result = await resolveJiraIssueLink({
      parsed: bareKey,
      sourceContext: context,
      readStatus: async () => status([site('1', 'https://acme.atlassian.net')], '1'),
      lookupSummary: async () => issue('PROJ-9')
    })
    expect(result).toMatchObject({ ok: true, linkedWorkItem: { jiraIdentifier: 'PROJ-9' } })
  })

  it('looks the issue up against the site a URL pins', async () => {
    let requestedSiteId: string | null = null
    const result = await resolveJiraIssueLink({
      parsed: pinnedUrl,
      sourceContext: context,
      readStatus: async () =>
        status(
          [site('1', 'https://acme.atlassian.net'), site('2', 'https://other.atlassian.net')],
          '2'
        ),
      lookupSummary: async (_ctx, _key, siteId) => {
        requestedSiteId = siteId
        return issue('PROJ-9')
      }
    })
    expect(result).toMatchObject({ ok: true })
    expect(requestedSiteId).toBe('1')
  })

  it('fails with not-found when the lookup returns nothing', async () => {
    const result = await resolveJiraIssueLink({
      parsed: bareKey,
      sourceContext: context,
      readStatus: async () => status([site('1', 'https://acme.atlassian.net')], '1'),
      lookupSummary: async () => null
    })
    expect(result).toEqual({ ok: false, errorKind: 'not-found' })
  })

  it('does not look up an issue when no site resolves', async () => {
    let lookedUp = false
    const result = await resolveJiraIssueLink({
      parsed: bareKey,
      sourceContext: context,
      readStatus: async () => status([]),
      lookupSummary: async () => {
        lookedUp = true
        return issue('PROJ-9')
      }
    })
    expect(result).toEqual({ ok: false, errorKind: 'not-connected' })
    expect(lookedUp).toBe(false)
  })
})
