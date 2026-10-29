import { beforeEach, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraIssueListFilters } from '../../../../shared/jira/jira-types'
import { createTestStore } from './store-test-helpers'
const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListIssues: list,
  jiraListIssuesForTarget: list,
  jiraSearchIssues: vi.fn()
}))
beforeEach(() => {
  vi.resetAllMocks()
})
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
it('isolates status results from preset caches and reuses an equivalent selection order', async () => {
  const store = createTestStore()
  list.mockImplementation(
    async (_source, _preset, _limit, _site, filters?: JiraIssueListFilters) => [
      issue(
        `${filters?.statuses?.join('-') || 'default'}${filters?.currentSprint ? '-sprint' : ''}`
      )
    ]
  )
  expect(await store.getState().listJiraIssues('all', 50)).toMatchObject([{ key: 'default' }])
  expect(
    await store.getState().listJiraIssues('all', 50, { filters: { statuses: ['Open'] } })
  ).toMatchObject([{ key: 'Open' }])
  expect(await store.getState().listJiraIssues('all', 50)).toMatchObject([{ key: 'default' }])
  expect(
    await store
      .getState()
      .listJiraIssues('all', 50, { filters: { statuses: ['In Progress', 'Blocked'] } })
  ).toMatchObject([{ key: 'Blocked-In Progress' }])
  await store
    .getState()
    .listJiraIssues('all', 50, { filters: { statuses: ['Blocked', 'In Progress'] } })
  expect(
    await store.getState().listJiraIssues('all', 50, {
      filters: { statuses: ['Blocked', 'In Progress'], currentSprint: true }
    })
  ).toMatchObject([{ key: 'Blocked-In Progress-sprint' }])
  await store.getState().listJiraIssues('all', 50, {
    filters: { currentSprint: true, statuses: ['In Progress', 'Blocked'] }
  })
  expect(
    await store.getState().listJiraIssues('all', 50, {
      filters: { statuses: ['Blocked', 'In Progress'] }
    })
  ).toMatchObject([{ key: 'Blocked-In Progress' }])
  expect(list).toHaveBeenCalledTimes(4)
})
