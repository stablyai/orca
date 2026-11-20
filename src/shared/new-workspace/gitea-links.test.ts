import { describe, expect, it } from 'vitest'
import {
  normalizeGiteaLinkQuery,
  parseGiteaWorkItemReference,
  parseGiteaIssueOrPRLink,
  parseGiteaIssueOrPRNumber
} from './gitea-links'

describe('parseGiteaIssueOrPRLink', () => {
  it('reads pull URLs from any host', () => {
    expect(parseGiteaIssueOrPRLink('https://git.example.com/acme/app/pulls/7')).toEqual({
      slug: { host: 'git.example.com', path: 'acme/app' },
      number: 7,
      type: 'pr'
    })
  })

  it('claims /issues/ only on known Gitea hosts unless told otherwise', () => {
    const url = 'https://git.example.com/acme/app/issues/3'
    expect(parseGiteaIssueOrPRLink(url)).toBeNull()
    expect(parseGiteaIssueOrPRLink(url, { assumeGitea: true })?.type).toBe('issue')
    expect(parseGiteaIssueOrPRLink('https://codeberg.org/acme/app/issues/3')?.number).toBe(3)
  })

  it('rejects GitHub-style pull URLs, credentials and nested paths', () => {
    expect(parseGiteaIssueOrPRLink('https://github.com/acme/app/pull/7')).toBeNull()
    expect(parseGiteaIssueOrPRLink('https://u:p@codeberg.org/acme/app/pulls/7')).toBeNull()
    expect(parseGiteaIssueOrPRLink('https://codeberg.org/a/b/c/pulls/7')).toBeNull()
  })
})

describe('Gitea number queries', () => {
  it('parses #N, !N and bare numbers', () => {
    expect(parseGiteaIssueOrPRNumber('#12')).toBe(12)
    expect(parseGiteaIssueOrPRNumber('!12')).toBe(12)
    expect(parseGiteaIssueOrPRNumber('12')).toBe(12)
    expect(parseGiteaIssueOrPRNumber('fix')).toBeNull()
  })

  it('turns a pasted URL into a direct-number lookup', () => {
    expect(normalizeGiteaLinkQuery('https://codeberg.org/acme/app/pulls/9')).toEqual({
      query: 'https://codeberg.org/acme/app/pulls/9',
      directNumber: 9
    })
    expect(normalizeGiteaLinkQuery('login bug').directNumber).toBeNull()
  })
})

describe('parseGiteaWorkItemReference', () => {
  it('reads #N, !N and bare numbers against the repo project', () => {
    expect(parseGiteaWorkItemReference('#12')).toEqual({
      number: 12,
      type: null,
      host: null,
      path: null
    })
    expect(parseGiteaWorkItemReference('!12')?.type).toBe('pr')
    expect(parseGiteaWorkItemReference('12')?.number).toBe(12)
  })

  it('reads owner/repo#N', () => {
    expect(parseGiteaWorkItemReference('acme/app#5')).toEqual({
      number: 5,
      type: null,
      host: null,
      path: 'acme/app'
    })
  })

  it('reads issue and pull URLs on any host', () => {
    expect(parseGiteaWorkItemReference('https://git.example.com/acme/app/issues/4')).toEqual({
      number: 4,
      type: 'issue',
      host: 'git.example.com',
      path: 'acme/app'
    })
  })

  it('leaves free text to search', () => {
    expect(parseGiteaWorkItemReference('fix login')).toBeNull()
    expect(parseGiteaWorkItemReference('#0')).toBeNull()
  })
})
