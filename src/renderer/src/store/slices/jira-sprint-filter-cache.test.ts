import { expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { JiraIssue, JiraIssueListFilters } from '../../../../shared/jira/jira-types'
import { createJiraSlice } from './jira'

const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListIssues: list,
  jiraListIssuesForTarget: list,
  jiraSearchIssues: vi.fn()
}))

it('separates combined filters while treating an unchecked sprint like the default view', async () => {
  const store = create<AppState>()(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These collection reads only access the supplied settings and Jira slice.
    (...args) => ({ settings: null, ...createJiraSlice(...args) }) as AppState
  )
  list.mockImplementation(
    async (
      _source,
      _preset,
      _limit,
      _site,
      filters?: JiraIssueListFilters
    ): Promise<JiraIssue[]> => [
      {
        id: 'sprint-cache',
        key: `${filters?.statuses?.join('-') || 'default'}${filters?.currentSprint ? '-sprint' : ''}`,
        title: 'Current filtered result',
        url: 'https://jira.invalid/browse/CACHE-1',
        project: { id: 'project', key: 'CACHE', name: 'Cache' },
        issueType: { id: 'task', name: 'Task' },
        status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
        labels: [],
        createdAt: '2026-10-14',
        updatedAt: '2026-10-14'
      }
    ]
  )
  const read = (filters?: JiraIssueListFilters) =>
    store.getState().listJiraIssues('all', 50, { filters })

  expect(await read()).toMatchObject([{ key: 'default' }])
  expect(await read({ currentSprint: false })).toMatchObject([{ key: 'default' }])
  expect(await read({ statuses: [], currentSprint: false })).toMatchObject([{ key: 'default' }])
  expect(list).toHaveBeenCalledTimes(1)

  expect(await read({ currentSprint: true })).toMatchObject([{ key: 'default-sprint' }])
  expect(await read({ statuses: ['Open'] })).toMatchObject([{ key: 'Open' }])
  expect(await read({ statuses: ['Open'], currentSprint: false })).toMatchObject([{ key: 'Open' }])
  expect(list).toHaveBeenCalledTimes(3)

  expect(await read({ statuses: ['Open'], currentSprint: true })).toMatchObject([
    { key: 'Open-sprint' }
  ])
  expect(await read({ statuses: ['Open', 'Open'], currentSprint: true })).toMatchObject([
    { key: 'Open-sprint' }
  ])
  expect(await read()).toMatchObject([{ key: 'default' }])
  expect(list).toHaveBeenCalledTimes(4)
})
