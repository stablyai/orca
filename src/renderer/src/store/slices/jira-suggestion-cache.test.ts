import { expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import { createTestStore } from './store-test-helpers'

const { jiraSearchIssues } = vi.hoisted(() => ({ jiraSearchIssues: vi.fn() }))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListIssues: vi.fn(),
  jiraListIssuesForTarget: vi.fn(),
  jiraSearchIssues
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    title: key,
    url: `https://jira.example/browse/${key}`,
    project: { id: 'project', key: 'APP', name: 'App' },
    issueType: { id: 'bug', name: 'Bug' },
    status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01'
  }
}
it('separates numeric suggestions, text, and filtered suggestions in-flight and in cache', async () => {
  try {
    const store = createTestStore()
    const text = deferred<JiraIssue[]>()
    const picker = deferred<JiraIssue[]>()
    const sprint = deferred<JiraIssue[]>()
    jiraSearchIssues
      .mockReturnValueOnce(text.promise)
      .mockReturnValueOnce(picker.promise)
      .mockReturnValueOnce(sprint.promise)
    const suggestions = { query: '400', currentJql: 'ORDER BY updated DESC' }
    const filtered = { ...suggestions, currentJql: 'sprint in openSprints()' }
    const plainRead = store.getState().searchJiraIssues('text ~ "400*"')
    const suggestedRead = store.getState().searchJiraIssues('text ~ "400*"', 30, { suggestions })
    const repeatedRead = store.getState().searchJiraIssues('text ~ "400*"', 30, { suggestions })
    const filteredRead = store
      .getState()
      .searchJiraIssues('text ~ "400*"', 30, { suggestions: filtered })
    text.resolve([issue('TEXT-1')])
    picker.resolve([issue('ALP-400')])
    sprint.resolve([issue('BRV-400')])
    await expect(
      Promise.all([plainRead, suggestedRead, repeatedRead, filteredRead])
    ).resolves.toMatchObject([
      [{ key: 'TEXT-1' }],
      [{ key: 'ALP-400' }],
      [{ key: 'ALP-400' }],
      [{ key: 'BRV-400' }]
    ])
    await expect(
      store.getState().searchJiraIssues('text ~ "400*"', 30, { suggestions })
    ).resolves.toMatchObject([{ key: 'ALP-400' }])
    expect(jiraSearchIssues).toHaveBeenCalledTimes(3)
  } finally {
    jiraSearchIssues.mockReset()
  }
})
