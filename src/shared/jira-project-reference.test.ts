import { describe, expect, it } from 'vitest'
import type { Repo } from './repo-types'
import type { JiraIssue } from './jira-types'
import {
  findJiraIssueDefaultRepo,
  normalizeJiraProjectReference,
  restrictJiraQueryToProject
} from './jira-project-reference'
import { createRepoUpdateSchema } from './rpc-contract/repo-update-params'
import { z } from 'zod'

const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const issue: JiraIssue = {
  id: 'issue',
  key: 'ALP-1',
  title: 'Fix',
  siteId: 'site-a',
  url: '',
  project,
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  updatedAt: '',
  createdAt: ''
}
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 0,
  defaultJiraProject: project
}

describe('Jira project mappings', () => {
  it('normalizes persisted references and drops malformed shapes', () => {
    expect(
      normalizeJiraProjectReference({ ...project, id: ' 10 ', token: 'must not persist' })
    ).toEqual(project)
    expect(normalizeJiraProjectReference({ ...project, siteId: '' })).toBeUndefined()
    expect(normalizeJiraProjectReference({ id: '10' })).toBeUndefined()
    expect(normalizeJiraProjectReference(null)).toBeNull()
  })

  it('validates the optional field for native and remote repository updates', () => {
    const schema = createRepoUpdateSchema({ repo: z.string() })
    expect(
      schema.parse({ repo: 'repo', updates: { defaultJiraProject: project } }).updates
        .defaultJiraProject
    ).toEqual(project)
    expect(
      schema.parse({ repo: 'repo', updates: { defaultJiraProject: null } }).updates
        .defaultJiraProject
    ).toBeNull()
    expect(
      schema.parse({ repo: 'repo', updates: { defaultJiraProject: { id: 'bad' } } }).updates
        .defaultJiraProject
    ).toBeUndefined()
  })

  it('chooses only a unique repository with the matching project, account, and host', () => {
    expect(findJiraIssueDefaultRepo([repo], issue, 'local')).toBe(repo)
    expect(findJiraIssueDefaultRepo([{ ...repo, kind: 'folder' }], issue, 'local')?.id).toBe('repo')
    expect(
      findJiraIssueDefaultRepo([repo, { ...repo, id: 'ambiguous' }], issue, 'local')
    ).toBeNull()
    expect(findJiraIssueDefaultRepo([repo], { ...issue, siteId: 'site-b' }, 'local')).toBeNull()
    expect(
      findJiraIssueDefaultRepo([{ ...repo, executionHostId: 'runtime:remote' }], issue, 'local')
    ).toBeNull()
    expect(
      findJiraIssueDefaultRepo(
        [{ ...repo, executionHostId: 'runtime:remote' }],
        issue,
        'runtime:remote'
      )?.id
    ).toBe('repo')
    expect(
      findJiraIssueDefaultRepo([{ ...repo, executionHostId: 'ssh:target' }], issue, 'local')?.id
    ).toBe('repo')
  })

  it.each([
    ['ORDER BY updated DESC', 'project = "10" ORDER BY updated DESC'],
    [
      'statusCategory != Done ORDER BY updated DESC',
      'project = "10" AND (statusCategory != Done) ORDER BY updated DESC'
    ],
    [
      'text ~ "order by speed" ORDER BY created ASC',
      'project = "10" AND (text ~ "order by speed") ORDER BY created ASC'
    ],
    ['key = "ALP-1" OR key = "ALP-2"', 'project = "10" AND (key = "ALP-1" OR key = "ALP-2")'],
    [
      "summary ~ 'order by' order by updated DESC",
      'project = "10" AND (summary ~ \'order by\') order by updated DESC'
    ],
    [
      'summary ~ "say \\"order by\\"" ORDER BY updated DESC',
      'project = "10" AND (summary ~ "say \\"order by\\"") ORDER BY updated DESC'
    ]
  ])('preserves query meaning and ordering when scoping %s', (jql, expected) => {
    expect(restrictJiraQueryToProject(jql, project)).toBe(expected)
  })
})
