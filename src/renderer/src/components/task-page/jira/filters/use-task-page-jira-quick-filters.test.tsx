// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskPageJiraQuickFilters } from './use-task-page-jira-quick-filters'
import type { JiraQuickFilterState } from '../../../../../../shared/jira/jira-quick-filters'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-quick-filter-state', () => ({
  readJiraQuickFilterState: read,
  writeJiraQuickFilterState: write
}))
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(cleanup)
function model(
  host: string | null,
  accountHost = 'account-owner'
): Parameters<typeof useTaskPageJiraQuickFilters>[0] {
  return {
    accountBackedTaskSourceHostId: toRuntimeExecutionHostId(accountHost),
    taskSource: 'jira',
    taskResumeApplied: true,
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
it('ignores a late mutation reply after changing Jira execution hosts', async () => {
  read
    .mockResolvedValueOnce({ statuses: ['Blocked'] })
    .mockResolvedValueOnce({ statuses: ['Open'] })
  let finish: (value: JiraQuickFilterState) => void = () => {}
  write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { result, rerender } = renderHook(({ host }) => useTaskPageJiraQuickFilters(model(host)), {
    initialProps: { host: 'a' }
  })
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = result.current.selectJiraStatuses(['In Progress'])
  })
  rerender({ host: 'b' })
  await waitFor(() => expect(result.current.selectedJiraStatuses).toEqual(['Open']))
  await act(async () => {
    finish({ statuses: ['In Progress'] })
    await pending
  })
  expect(result.current.selectedJiraStatuses).toEqual(['Open'])
})
