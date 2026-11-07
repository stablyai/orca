import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import { searchScopedTaskPageJiraIssues, searchTaskPageJiraIssues } from './task-page-jira-search'

const ISSUE: JiraIssue = {
  id: '10001',
  key: 'ABC-1',
  title: 'Fix login',
  url: 'https://jira.example.com/browse/ABC-1',
  project: { id: '10000', key: 'ABC', name: 'ABC' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z'
}

describe('searchTaskPageJiraIssues', () => {
  it('looks up a bare issue number in the selected project, then falls back to its text', async () => {
    const search = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ISSUE])
    await expect(searchTaskPageJiraIssues('400', search, 'input', ['PROJ'])).resolves.toEqual({
      issues: [ISSUE],
      jqlRejection: null
    })
    expect(search.mock.calls).toEqual([['key = "PROJ-400"'], ['text ~ "400*"']])
  })

  it('retries a multi-project lookup without the keys Jira says are missing', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Error 400: An issue with key 'BET-400' does not exist for field 'key'.")
      )
      .mockResolvedValueOnce([ISSUE])
    await expect(
      searchTaskPageJiraIssues('400', search, 'input', ['ALP', 'BET', 'CAT'])
    ).resolves.toEqual({ issues: [ISSUE], jqlRejection: null })
    expect(search.mock.calls).toEqual([
      ['key in ("ALP-400", "BET-400", "CAT-400")'],
      ['key in ("ALP-400", "CAT-400")']
    ])
  })
})

describe('searchScopedTaskPageJiraIssues', () => {
  it('searches the text alone when the key lookup across projects exceeds the request limit', async () => {
    const projects = Array.from({ length: 700 }, (_, index) => ({
      id: String(index),
      key: `PROJECT${index}`,
      name: `Project ${index}`
    }))
    const search = vi.fn().mockResolvedValue([ISSUE])
    await searchScopedTaskPageJiraIssues('400', search, 'input', false, null, projects)
    expect(search.mock.calls).toEqual([['text ~ "400*"']])
  })
})
