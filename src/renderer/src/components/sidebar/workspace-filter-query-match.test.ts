import { describe, expect, it } from 'vitest'
import { parseWorkspaceFilterQuery } from './workspace-filter-query'
import {
  workspaceMatchesFilterQuery,
  type WorkspaceFilterSubject,
  type WorkspaceFilterTextVerdicts
} from './workspace-filter-query-match'

function subject(overrides: Partial<WorkspaceFilterSubject> = {}): WorkspaceFilterSubject {
  return {
    kind: 'worktree',
    name: 'Fix relay parser',
    branch: 'fix/relay-parser',
    repoName: 'orca',
    repoPath: '/Users/me/src/orca',
    hostId: 'ssh:buildbox',
    hostLabel: 'Build Box',
    path: '/Users/me/src/orca-wt/relay',
    statusId: 'in-review',
    statusLabel: 'In Review',
    comment: 'waiting on CI',
    prNumbers: [21823],
    issueNumbers: [21800],
    pinned: false,
    main: false,
    sleeping: false,
    detached: false,
    cli: false,
    automation: true,
    unread: true,
    ...overrides
  }
}

const NO_TEXT: WorkspaceFilterTextVerdicts = {
  identityMatched: null,
  anyMatched: null
}

function matches(
  query: string,
  overrides: Partial<WorkspaceFilterSubject> = {},
  verdicts: WorkspaceFilterTextVerdicts = NO_TEXT,
  rowKey = 'row'
): boolean {
  return workspaceMatchesFilterQuery({
    parsed: parseWorkspaceFilterQuery(query),
    subject: subject(overrides),
    rowKey,
    verdicts
  })
}

describe('workspaceMatchesFilterQuery', () => {
  it('accepts everything for an inactive query', () => {
    expect(matches('')).toBe(true)
  })

  it('matches string qualifiers as case-insensitive substrings across their fields', () => {
    expect(matches('host:build')).toBe(true)
    expect(matches('host:SSH:buildbox')).toBe(true)
    expect(matches('branch:RELAY')).toBe(true)
    expect(matches('repo:src/orca')).toBe(true)
    expect(matches('path:orca-wt')).toBe(true)
    expect(matches('status:review')).toBe(true)
    expect(matches('name:parser')).toBe(true)
    expect(matches('host:laptop')).toBe(false)
  })

  it('ORs values within one qualifier and ANDs qualifiers together', () => {
    expect(matches('host:laptop,build')).toBe(true)
    expect(matches('host:build branch:main')).toBe(false)
  })

  it('negates a qualifier with a leading dash', () => {
    expect(matches('-host:build')).toBe(false)
    expect(matches('-branch:main')).toBe(true)
  })

  it('answers is: flags and rejects unknown flags', () => {
    expect(matches('is:automation')).toBe(true)
    expect(matches('is:unread,pinned')).toBe(true)
    expect(matches('is:active')).toBe(true)
    expect(matches('is:sleeping')).toBe(false)
    expect(matches('is:sleeping', { sleeping: true })).toBe(true)
    expect(matches('is:folder')).toBe(false)
    expect(matches('is:folder', { kind: 'folder' })).toBe(true)
    expect(matches('is:bogus')).toBe(false)
    expect(matches('-is:pinned')).toBe(true)
  })

  it('matches pr: and issue: numbers with or without a sigil', () => {
    expect(matches('pr:21823')).toBe(true)
    expect(matches('pr:#21823')).toBe(true)
    expect(matches('issue:21800')).toBe(true)
    expect(matches('pr:21800')).toBe(false)
  })

  it('defers free text to the identity verdict set and honors negated words', () => {
    const verdicts: WorkspaceFilterTextVerdicts = {
      identityMatched: new Set(['row']),
      anyMatched: null
    }
    expect(matches('relay', {}, verdicts)).toBe(true)
    expect(matches('relay', {}, verdicts, 'other-row')).toBe(false)
    expect(matches('relay -orca', {}, verdicts)).toBe(false)
  })

  it('uses the any: verdict set when present and substring fallback otherwise', () => {
    expect(matches('any:CI')).toBe(true)
    expect(matches('any:nothing')).toBe(false)
    const verdicts: WorkspaceFilterTextVerdicts = {
      identityMatched: null,
      anyMatched: new Set(['row'])
    }
    expect(matches('any:zzz', {}, verdicts)).toBe(true)
    expect(matches('any:zzz', {}, verdicts, 'other-row')).toBe(false)
  })
})
