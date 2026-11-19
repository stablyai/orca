import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'
import { findTaskPageJiraIssue } from './task-page-jira-cache-selectors'

function issue(statusName: string, updatedAt: string): JiraIssue {
  return {
    id: 'ALP-1',
    key: 'ALP-1',
    title: 'ALP-1',
    url: 'https://example.atlassian.net/browse/ALP-1',
    siteId: 'site-1',
    project: { id: '10000', key: 'ALP', name: 'Alpha', siteId: 'site-1' },
    issueType: { id: '10001', name: 'Bug' },
    status: {
      id: statusName,
      name: statusName,
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt
  }
}

describe('findTaskPageJiraIssue', () => {
  it('returns the most recently updated copy when an older search still holds a stale one', () => {
    const stale = issue('In Progress', '2026-11-18T10:00:00.000+0200')
    const fresh = issue('Done', '2026-11-19T12:30:28.209+0200')
    const searchCache = {
      'site-1::assignee = currentUser()::30': { data: [stale], fetchedAt: 1 },
      'site-1::project = ALP ORDER BY updated DESC::30': { data: [fresh], fetchedAt: 2 }
    }

    expect(findTaskPageJiraIssue({}, searchCache, 'ALP-1')?.status.name).toBe('Done')
  })

  it('keeps the issue-cache copy, which carries optimistic edits, when both copies have the same update time', () => {
    const edited = { ...issue('Done', '2026-11-19T12:30:28.209+0200'), title: 'Edited title' }
    const fromSearch = issue('Done', '2026-11-19T12:30:28.209+0200')

    const found = findTaskPageJiraIssue(
      { 'site-1::ALP-1': { data: edited, fetchedAt: 0 } },
      { 'site-1::project = ALP::30': { data: [fromSearch], fetchedAt: 5 } },
      'ALP-1'
    )

    expect(found?.title).toBe('Edited title')
  })
})
