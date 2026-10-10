import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../shared/jira-types'
import { searchTaskPageJiraIssues } from './task-page-jira-search'

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
const SYNTAX_ERROR = "Error 400: Error in the JQL Query: Expecting operator but got 'slow'."
// Shape of the same failure when it crosses local Electron IPC.
const IPC_SYNTAX_ERROR = `Error invoking remote method 'jira:searchIssues': Error: ${SYNTAX_ERROR}`

describe('searchTaskPageJiraIssues', () => {
  it('searches plain text without a JQL round trip', async () => {
    const search = vi.fn().mockResolvedValue([ISSUE])
    await expect(searchTaskPageJiraIssues(' s ', search)).resolves.toEqual({
      issues: [ISSUE],
      jqlRejection: null
    })
    expect(search.mock.calls).toEqual([['text ~ "s*"']])
  })

  it('looks up an issue key directly', async () => {
    const search = vi.fn().mockResolvedValue([ISSUE])
    await searchTaskPageJiraIssues('abc-1', search)
    expect(search.mock.calls).toEqual([['key = "ABC-1"']])
  })

  it('retries a key-shaped search as text when no issue has that key', async () => {
    const search = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ISSUE])
    await expect(searchTaskPageJiraIssues('utf-8', search)).resolves.toEqual({
      issues: [ISSUE],
      jqlRejection: null
    })
    expect(search.mock.calls).toEqual([['key = "UTF-8"'], ['text ~ "utf 8*"']])
  })

  it('retries a key-shaped search as text when Jira says the key does not exist', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Error 400: An issue with key 'ABC-999' does not exist for field 'key'.")
      )
      .mockResolvedValueOnce([ISSUE])
    await expect(searchTaskPageJiraIssues('abc-999', search)).resolves.toEqual({
      issues: [ISSUE],
      jqlRejection: null
    })
    expect(search.mock.calls).toEqual([['key = "ABC-999"'], ['text ~ "abc 999*"']])
  })

  it('does not mask a key lookup that failed for another reason', async () => {
    const error = new Error('Error 403: Forbidden')
    const search = vi.fn().mockRejectedValue(error)
    await expect(searchTaskPageJiraIssues('abc-999', search)).rejects.toBe(error)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('searches everyday phrases with `in` and `is` as text in one request', async () => {
    const search = vi.fn().mockResolvedValue([ISSUE])
    await searchTaskPageJiraIssues('crash in terminal', search)
    await searchTaskPageJiraIssues('login is slow', search)
    expect(search.mock.calls).toEqual([
      ['text ~ "crash in terminal*"'],
      ['text ~ "login is slow*"']
    ])
  })

  it('does not retry a key lookup that found the issue', async () => {
    const search = vi.fn().mockResolvedValue([ISSUE])
    await searchTaskPageJiraIssues('sha-256', search)
    expect(search.mock.calls).toEqual([['key = "SHA-256"']])
  })

  it('runs input Jira accepts as JQL unchanged', async () => {
    const search = vi.fn().mockResolvedValue([ISSUE])
    await expect(searchTaskPageJiraIssues('status WAS Done', search)).resolves.toEqual({
      issues: [ISSUE],
      jqlRejection: null
    })
    expect(search.mock.calls).toEqual([['status WAS Done']])
  })

  it.each([SYNTAX_ERROR, IPC_SYNTAX_ERROR])(
    'falls back to text when Jira rejects the input as JQL: %s',
    async (message) => {
      const search = vi
        .fn()
        .mockRejectedValueOnce(new Error(message))
        .mockResolvedValueOnce([ISSUE])
      await expect(searchTaskPageJiraIssues('login was slow', search)).resolves.toEqual({
        issues: [ISSUE],
        jqlRejection: {
          reason: "Error in the JQL Query: Expecting operator but got 'slow'.",
          likelyTypo: false
        }
      })
      expect(search.mock.calls).toEqual([['login was slow'], ['text ~ "login was slow*"']])
    }
  )

  it('marks a rejected `=` query as a likely JQL typo', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Error 400: The value 'NOPE' does not exist for the field 'project'.")
      )
      .mockResolvedValueOnce([])
    await expect(searchTaskPageJiraIssues('project = NOPE', search)).resolves.toEqual({
      issues: [],
      jqlRejection: {
        reason: "The value 'NOPE' does not exist for the field 'project'.",
        likelyTypo: true
      }
    })
  })

  it.each([
    'Error 401: Unauthorized',
    'Error 403: Forbidden',
    'Error 429: Too Many Requests',
    'Error 503: Service Unavailable',
    'fetch failed'
  ])('does not mask non-query failures: %s', async (message) => {
    const error = new Error(message)
    const search = vi.fn().mockRejectedValue(error)
    await expect(searchTaskPageJiraIssues('status = Done', search)).rejects.toBe(error)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it.each(['fetch failed', 'Error 429: Too Many Requests', 'Error 503: Service Unavailable'])(
    'surfaces the text retry failure instead of blaming the query: %s',
    async (message) => {
      const retryError = new Error(message)
      const search = vi
        .fn()
        .mockRejectedValueOnce(new Error(SYNTAX_ERROR))
        .mockRejectedValueOnce(retryError)
      await expect(searchTaskPageJiraIssues('login was slow', search)).rejects.toBe(retryError)
    }
  )

  it('keeps the JQL error when Jira also rejects the text retry', async () => {
    const jqlError = new Error(SYNTAX_ERROR)
    const search = vi
      .fn()
      .mockRejectedValueOnce(jqlError)
      .mockRejectedValueOnce(new Error("Error 400: Unable to parse the text 'x' for field 'text'."))
    await expect(searchTaskPageJiraIssues('login was slow', search)).rejects.toBe(jqlError)
  })

  it('sends partially typed punctuation as plain text', async () => {
    const search = vi.fn().mockResolvedValue([ISSUE])
    await searchTaskPageJiraIssues('fix (login', search)
    await searchTaskPageJiraIssues('say "hi', search)
    expect(search.mock.calls).toEqual([['text ~ "fix login*"'], ['text ~ "say hi*"']])
  })

  it('skips the request when only punctuation was typed', async () => {
    const search = vi.fn()
    await expect(searchTaskPageJiraIssues('(', search)).resolves.toEqual({
      issues: [],
      jqlRejection: null
    })
    expect(search).not.toHaveBeenCalled()
  })

  it('reports the JQL error when no words remain to retry as text', async () => {
    const jqlError = new Error('Error 400: Error in the JQL Query: bad')
    const search = vi.fn().mockRejectedValueOnce(jqlError)
    await expect(searchTaskPageJiraIssues('~ !', search)).rejects.toBe(jqlError)
    expect(search).toHaveBeenCalledTimes(1)
  })
})
