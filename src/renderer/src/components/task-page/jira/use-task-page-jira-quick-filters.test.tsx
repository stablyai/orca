// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskPageJiraQuickFilters } from './use-task-page-jira-quick-filters'
import type { JiraQuickFilterState } from '../../../../../shared/jira/jira-quick-filters'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
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
it.each(['success', 'failure'] as const)(
  'keeps a new owner visit pending after an old %s settlement',
  async (outcome) => {
    read.mockResolvedValue({ statuses: ['Open'] })
    let finishOld: (state: JiraQuickFilterState) => void = () => {}
    let failOld: (reason: Error) => void = () => {}
    let finishNew: (state: JiraQuickFilterState) => void = () => {}
    write
      .mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finishOld = resolve
          failOld = reject
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve
        })
      )
    const { result, rerender } = renderHook(
      ({ host }) => useTaskPageJiraQuickFilters(model(host)),
      { initialProps: { host: 'a' } }
    )
    await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
    let oldWrite = Promise.resolve()
    act(() => {
      oldWrite = result.current.selectJiraStatuses(['Closed']).catch(() => {})
    })
    rerender({ host: 'b' })
    await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
    rerender({ host: 'a' })
    await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
    let newWrite = Promise.resolve()
    act(() => {
      newWrite = result.current.selectJiraStatuses(['In Progress'])
    })
    await act(async () => {
      if (outcome === 'success') {
        finishOld({ statuses: ['Closed'] })
      } else {
        failOld(new Error('Old request failed'))
      }
      await oldWrite
    })
    expect(result.current.jiraQuickFiltersPending).toBe(true)
    expect(result.current.selectedJiraStatuses).toEqual(['Open'])
    expect(result.current.jiraQuickFiltersError).toBeNull()
    await act(async () => {
      finishNew({ statuses: ['In Progress'] })
      await newWrite
    })
    expect(result.current.selectedJiraStatuses).toEqual(['In Progress'])
    expect(result.current.jiraQuickFiltersPending).toBe(false)
  }
)
