import { describe, expect, it } from 'vitest'
import {
  isYouTrackLookupTextFor,
  parseYouTrackIssueIdPrefix,
  parseYouTrackIssueReference
} from './youtrack-issue-reference'
import { buildSmartWorkspaceSourceRows } from './new-workspace/smart-workspace-source-results'
import { isExactYouTrackMatch } from './new-workspace/smart-workspace-youtrack-rows'
import type { YouTrackIssue } from './youtrack-types'

const BASE = 'https://yt.example.com/youtrack'

describe('parseYouTrackIssueReference', () => {
  it('reads bare IDs in any case', () => {
    expect(parseYouTrackIssueReference(' proj-81 ', null)).toBe('PROJ-81')
    expect(parseYouTrackIssueReference('PROJ', BASE)).toBeNull()
    expect(parseYouTrackIssueReference('fix login', BASE)).toBeNull()
  })

  it('reads issue URLs only from the connected instance', () => {
    expect(parseYouTrackIssueReference(`${BASE}/issue/PROJ-81/some-slug`, BASE)).toBe('PROJ-81')
    expect(parseYouTrackIssueReference(`${BASE}/issue/proj-81`, BASE)).toBe('PROJ-81')
    expect(parseYouTrackIssueReference('https://other.example.com/issue/PROJ-81', BASE)).toBeNull()
    expect(
      parseYouTrackIssueReference('https://acme.atlassian.net/browse/PROJ-81', BASE)
    ).toBeNull()
  })
})

describe('parseYouTrackIssueIdPrefix', () => {
  it('accepts project prefixes with or without digits', () => {
    expect(parseYouTrackIssueIdPrefix('proj-')).toBe('PROJ-')
    expect(parseYouTrackIssueIdPrefix(' proj-8 ')).toBe('PROJ-8')
    expect(parseYouTrackIssueIdPrefix('proj')).toBeNull()
    expect(parseYouTrackIssueIdPrefix('fix-login')).toBeNull()
  })
})

describe('isYouTrackLookupTextFor', () => {
  const issue = { idReadable: 'PROJ-81', url: `${BASE}/issue/PROJ-81` }

  it('treats the ID, an ID prefix, or the issue URL as lookup text', () => {
    expect(isYouTrackLookupTextFor('proj-8', issue)).toBe(true)
    expect(isYouTrackLookupTextFor('PROJ-81', issue)).toBe(true)
    expect(isYouTrackLookupTextFor(`${BASE}/issue/PROJ-81/some-slug`, issue)).toBe(true)
  })

  it('keeps names that did not find this issue', () => {
    expect(isYouTrackLookupTextFor('proj-9', issue)).toBe(false)
    expect(isYouTrackLookupTextFor('fix login', issue)).toBe(false)
    expect(isYouTrackLookupTextFor(`${BASE}/issue/PROJ-82`, issue)).toBe(false)
  })
})

describe('buildSmartWorkspaceSourceRows with a YouTrack issue', () => {
  const issue: YouTrackIssue = {
    id: '2-81',
    idReadable: 'PROJ-81',
    summary: 'Tests',
    url: `${BASE}/issue/PROJ-81`,
    project: { id: '0-16', shortName: 'PROJ', name: 'Project' },
    state: null,
    stateFieldName: null,
    assignee: null,
    reporter: null,
    priority: null,
    type: null,
    fields: [],
    tags: [],
    links: [],
    unresolvedBlockerCount: 0,
    resolved: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z'
  }
  const base = {
    branches: [],
    githubItems: [],
    gitlabAvailable: false,
    gitlabItems: [],
    linearAvailable: false,
    linearIssues: [],
    resultLimit: 10,
    value: 'PROJ-81'
  }

  it('puts the resolved issue first in smart mode', () => {
    const rows = buildSmartWorkspaceSourceRows({ ...base, mode: 'smart', youtrackIssues: [issue] })
    expect(rows.map((row) => row.kind)).toEqual(['youtrack', 'use-name'])
  })

  it('keeps "use as name" first when the input is only an ID prefix', () => {
    const rows = buildSmartWorkspaceSourceRows({
      ...base,
      value: 'proj-8',
      mode: 'smart',
      youtrackIssues: [issue]
    })
    expect(rows.map((row) => row.kind)).toEqual(['use-name', 'youtrack'])
  })

  it('counts only a full ID or issue URL as an exact match', () => {
    expect(isExactYouTrackMatch(issue, ' proj-81 ')).toBe(true)
    expect(isExactYouTrackMatch(issue, `${BASE}/issue/PROJ-81`)).toBe(true)
    expect(isExactYouTrackMatch(issue, 'proj-8')).toBe(false)
  })

  it('leaves other modes alone', () => {
    const rows = buildSmartWorkspaceSourceRows({ ...base, mode: 'github', youtrackIssues: [issue] })
    expect(rows.some((row) => row.kind === 'youtrack')).toBe(false)
  })
})
