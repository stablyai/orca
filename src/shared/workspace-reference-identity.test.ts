import { describe, expect, it } from 'vitest'
import {
  getWorkspaceReferenceIdentity,
  matchesWorkspaceReferenceQuery,
  parseWorkspaceReferenceQuery,
  parseWorkspaceReferenceUrl
} from './workspace-reference-identity'
import type { WorkspaceAttachment } from './worktree/types'

const identity = (url: string): string =>
  getWorkspaceReferenceIdentity(parseWorkspaceReferenceUrl(url))

describe('reference URLs', () => {
  it.each([
    [
      'https://github.com/ACME/api/pull/5123/files?x=1#note',
      'github',
      'pr',
      5123,
      'https://github.com/ACME/api/pull/5123'
    ],
    [
      'https://github.com/acme/api/issues/42',
      'github',
      'issue',
      42,
      'https://github.com/acme/api/issues/42'
    ],
    [
      'https://git.example:8443/group/subgroup/api/-/merge_requests/42/diffs',
      'gitlab',
      'mr',
      42,
      'https://git.example:8443/group/subgroup/api/-/merge_requests/42'
    ],
    [
      'https://gitlab.com/acme/api/-/issues/42',
      'gitlab',
      'issue',
      42,
      'https://gitlab.com/acme/api/-/issues/42'
    ],
    [
      'https://codeberg.org/acme/api/pulls/42',
      'gitea',
      'pr',
      42,
      'https://codeberg.org/acme/api/pulls/42'
    ],
    [
      'https://codeberg.org/acme/api/issues/42',
      'gitea',
      'issue',
      42,
      'https://codeberg.org/acme/api/issues/42'
    ],
    [
      'https://bitbucket.org/acme/api/pull-requests/42',
      'bitbucket',
      'pr',
      42,
      'https://bitbucket.org/acme/api/pull-requests/42'
    ],
    [
      'https://git.example/projects/ACME/repos/api/pull-requests/42/overview',
      'bitbucket',
      'pr',
      42,
      'https://git.example/projects/ACME/repos/api/pull-requests/42'
    ],
    [
      'https://dev.azure.com/acme/project/_git/api/pullrequest/42',
      'azure-devops',
      'pr',
      42,
      'https://dev.azure.com/acme/project/_git/api/pullrequest/42'
    ],
    [
      'https://linear.app/acme/issue/sta-1234/fix-it',
      'linear',
      'issue',
      0,
      'https://linear.app/acme/issue/STA-1234'
    ],
    [
      'https://jira.example:8443/jira/browse/sta-1234?selectedItem=x',
      'jira',
      'issue',
      0,
      'https://jira.example:8443/jira/browse/STA-1234'
    ]
  ])('parses %s without provider calls', (input, provider, type, number, url) => {
    expect(parseWorkspaceReferenceUrl(input)).toMatchObject({ provider, type, number, url })
    expect(parseWorkspaceReferenceUrl(input).origins).toBeUndefined()
  })

  it.each([
    '5123',
    'github:pr:5123',
    'acme/api#5123',
    'file://github.com/acme/api/pull/42',
    'https://user:password@github.com/acme/api/pull/42',
    'https://github.com/acme/api/pull/0',
    'https://github.com/acme/api/pull/9007199254740992',
    'https://github.com/acme/api/pulls/42',
    'https://codeberg.org/acme/api/pull/42',
    'https://github.com/acme/api/-/merge_requests/42',
    'https://github.com/browse/STA-1234',
    'https://unknown.example/acme/api/issues/42',
    'https://linear.app/acme/issue/invalid'
  ])('rejects ambiguous or invalid input %s', (input) => {
    expect(() => parseWorkspaceReferenceUrl(input)).toThrow()
  })

  it('accepts a known provider hint for self-hosted issue metadata', () => {
    expect(
      parseWorkspaceReferenceUrl('https://git.example/acme/api/issues/42', 'gitea').provider
    ).toBe('gitea')
  })
})

describe('reference identity', () => {
  it('ignores fragments, views, leading zeros and GitHub casing', () => {
    expect(identity('https://github.com/ACME/Api/pull/0042/files#diff')).toBe(
      identity('https://github.com/acme/api/pull/42')
    )
  })

  it.each([
    ['https://www.github.com/acme/api/pull/42', 'https://github.com/acme/api/pull/42'],
    [
      'https://gitlab.com/Group/Api/-/merge_requests/42',
      'https://gitlab.com/group/api/-/merge_requests/42'
    ],
    ['https://codeberg.org/Acme/Api/pulls/42', 'https://codeberg.org/acme/api/pulls/42']
  ])('treats case-insensitive host routes as one source: %s vs %s', (a, b) => {
    expect(identity(a)).toBe(identity(b))
  })

  it.each([
    'https://github.com/ACME/Api/pull/42',
    'https://git.example/Root/Group/Api/-/merge_requests/42',
    'https://codeberg.org/Acme/Api/pulls/42'
  ])('stores %s with its original path casing', (url) => {
    expect(parseWorkspaceReferenceUrl(url).url).toBe(url)
    expect(identity(url)).toBe(identity(url.toLowerCase()))
  })

  it('does not read git-host /browse/ paths as Jira issues', () => {
    expect(
      parseWorkspaceReferenceUrl('https://git.example/acme/api/issues/42', 'github').provider
    ).toBe('github')
    expect(() =>
      parseWorkspaceReferenceUrl('https://git.example/acme/api/browse/STA-1', 'github')
    ).toThrow()
    expect(() => parseWorkspaceReferenceUrl('https://github.com/acme/browse/STA-1')).toThrow()
    expect(() =>
      parseWorkspaceReferenceUrl('https://git.example/projects/P/repos/api/browse/STA-1')
    ).toThrow()
  })

  it.each([
    ['https://github.com/acme/api/pull/42', 'https://github.com/acme/other/pull/42'],
    ['https://github.com/acme/api/pull/42', 'https://github.com/acme/api/issues/42'],
    ['https://git.example:8443/acme/api/pull/42', 'https://git.example:9443/acme/api/pull/42'],
    ['https://linear.app/acme/issue/STA-1234', 'https://linear.app/other/issue/STA-1234'],
    ['https://jira.example/jira/browse/STA-1234', 'https://jira.example/other/browse/STA-1234'],
    [
      'https://jira.example:8443/jira/browse/STA-1234',
      'https://jira.example:9443/jira/browse/STA-1234'
    ],
    ['https://git.example/a/api/-/issues/42', 'https://other.example/a/api/-/issues/42']
  ])('keeps distinct sources separate: %s vs %s', (a, b) => {
    expect(identity(a)).not.toBe(identity(b))
  })

  it('does not let local repository IDs split a proven external identity', () => {
    const reference = parseWorkspaceReferenceUrl('https://github.com/acme/api/pull/42')
    expect(getWorkspaceReferenceIdentity({ ...reference, repoId: 'repo-a' })).toBe(
      getWorkspaceReferenceIdentity({ ...reference, repoId: 'repo-b' })
    )
  })

  it('matches URL-less entries only when stored provider metadata proves the source', () => {
    const item: WorkspaceAttachment = {
      provider: 'github',
      type: 'pr',
      number: 42,
      taskSourceContext: {
        kind: 'task-source',
        provider: 'github',
        projectId: 'local-project',
        hostId: 'local',
        providerIdentity: { provider: 'github', owner: 'acme', repo: 'api' }
      }
    }
    expect(getWorkspaceReferenceIdentity(item)).toBe(
      identity('https://github.com/acme/api/pull/42')
    )
    expect(getWorkspaceReferenceIdentity({ ...item, taskSourceContext: undefined })).not.toBe(
      getWorkspaceReferenceIdentity(item)
    )
  })

  it('retains source boundaries in legacy opaque keys', () => {
    const item: WorkspaceAttachment = {
      provider: 'github',
      type: 'pr',
      number: 42,
      repoId: 'repo-a'
    }
    expect(getWorkspaceReferenceIdentity(item)).not.toBe(
      getWorkspaceReferenceIdentity({ ...item, repoId: 'repo-b' })
    )
  })

  it('does not trust URLs that contradict stored provider or reference ID', () => {
    const parsed = parseWorkspaceReferenceUrl('https://github.com/acme/api/pull/42')
    expect(getWorkspaceReferenceIdentity({ ...parsed, number: 43 })).not.toBe(
      getWorkspaceReferenceIdentity(parsed)
    )
    expect(getWorkspaceReferenceIdentity({ ...parsed, provider: 'gitea' })).not.toBe(
      getWorkspaceReferenceIdentity(parsed)
    )
  })
})

describe('reference queries', () => {
  it('finds a native issue key across every source', () => {
    const query = parseWorkspaceReferenceQuery('sta-1234')
    for (const url of [
      'https://linear.app/acme/issue/STA-1234',
      'https://linear.app/other/issue/STA-1234',
      'https://jira.example/browse/STA-1234'
    ]) {
      expect(matchesWorkspaceReferenceQuery(parseWorkspaceReferenceUrl(url), query)).toBe(true)
    }
    expect(
      matchesWorkspaceReferenceQuery(
        parseWorkspaceReferenceUrl('https://linear.app/acme/issue/STA-2'),
        query
      )
    ).toBe(false)
  })

  it('uses exact source identity for a URL query', () => {
    const query = parseWorkspaceReferenceQuery('https://linear.app/acme/issue/STA-1234')
    expect(
      matchesWorkspaceReferenceQuery(
        parseWorkspaceReferenceUrl('https://linear.app/acme/issue/STA-1234/title'),
        query
      )
    ).toBe(true)
    expect(
      matchesWorkspaceReferenceQuery(
        parseWorkspaceReferenceUrl('https://linear.app/other/issue/STA-1234'),
        query
      )
    ).toBe(false)
  })

  it('finds a self-hosted issue URL whose provider the URL alone cannot prove', () => {
    const url = 'https://git.example/Acme/Api/issues/42'
    expect(() => parseWorkspaceReferenceUrl(url)).toThrow()
    const query = parseWorkspaceReferenceQuery(url)
    for (const provider of ['github', 'gitea'] as const) {
      expect(matchesWorkspaceReferenceQuery(parseWorkspaceReferenceUrl(url, provider), query)).toBe(
        true
      )
    }
    expect(
      matchesWorkspaceReferenceQuery(
        parseWorkspaceReferenceUrl('https://git.example/acme/api/issues/43', 'gitea'),
        query
      )
    ).toBe(false)
    expect(() =>
      parseWorkspaceReferenceQuery('https://git.example/acme/api/pull-requests/42')
    ).toThrow()
  })

  it.each(['1234', '#1234', 'github:pr:1234'])('rejects %s', (query) => {
    expect(() => parseWorkspaceReferenceQuery(query)).toThrow()
  })
})
