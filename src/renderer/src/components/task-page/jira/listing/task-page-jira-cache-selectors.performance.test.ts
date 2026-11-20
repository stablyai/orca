import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'
import { resolveTaskPageJiraIssues } from './task-page-jira-cache-selectors'

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

describe('Jira list cache projection scan bound', () => {
  // Guards the refreshed-row resolution in #45049 without repeating cache scans per row.
  it.each([100, 1000])('visits each cached issue once for %i displayed rows', (size) => {
    let reads = 0
    const stale = Array.from({ length: size }, (_, i) => ({
      ...issue('In Progress', '2026-11-18T10:00:00.000Z'),
      key: `ALP-${i}`
    }))
    const fresh = stale.map((value) => {
      const candidate = {
        ...value,
        status: { ...value.status, name: 'Done' },
        updatedAt: '2026-11-19T12:00:00.000Z'
      }
      return {
        ...candidate,
        get key() {
          reads += 1
          return candidate.key
        }
      }
    })
    const searchCache = Object.fromEntries(
      fresh.map((value, i) => [`site-1::search-${i}`, { data: [value], fetchedAt: 20 }])
    )

    const resolved = resolveTaskPageJiraIssues(stale, {}, searchCache)

    expect(resolved).toHaveLength(size)
    expect(resolved.every((value) => value.status.name === 'Done')).toBe(true)
    expect(reads).toBeLessThanOrEqual(size * 2)
  })
})
