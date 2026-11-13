// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
const { read, mutate } = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-saved-filter-state', () => ({
  readJiraSavedFilterState: read,
  mutateJiraSavedFilters: mutate
}))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
})
const filter = { id: 'mine', name: 'My work', jql: 'project = APP' }
const initial = { filters: [filter], activeFilterId: filter.id }
function model(
  host: string | null,
  accountHost = 'account-owner'
): Parameters<typeof useTaskPageJiraSavedFilters>[0] {
  return {
    taskSource: 'jira',
    taskResumeApplied: true,
    accountBackedTaskSourceHostId: toRuntimeExecutionHostId(accountHost),
    jiraTaskSourceContext: host
      ? {
          kind: 'task-source',
          provider: 'jira',
          projectId: 'project',
          hostId: toRuntimeExecutionHostId(host)
        }
      : null
  }
}
it('ignores an old host read that completes after switching execution hosts', async () => {
  let resolveOld: (value: typeof initial) => void = () => {}
  read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    .mockResolvedValueOnce({ filters: [], activeFilterId: null })
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ host }) => useTaskPageJiraSavedFilters(model(host), setQuery),
    { initialProps: { host: 'host-a' } }
  )
  rerender({ host: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await act(async () => {
    resolveOld(initial)
  })
  expect(result.current.jiraSavedFilters).toEqual([])
  expect(setQuery).not.toHaveBeenCalledWith(filter.jql)
})
