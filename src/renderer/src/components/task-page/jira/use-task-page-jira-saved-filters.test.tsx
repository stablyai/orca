// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { startTransition, Suspense } from 'react'
import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
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
it.each(['success', 'failure'] as const)(
  'keeps a new visit to the owner pending after an old write settles with %s',
  async (settlement) => {
    read.mockResolvedValue(initial)
    let settleOld = () => {}
    let settleNew = () => {}
    mutate
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settleOld = () =>
              settlement === 'success'
                ? resolve({ filters: [], activeFilterId: null })
                : reject(new Error('Old host disconnected'))
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleNew = () => resolve(initial)
          })
      )
    const setQuery = vi.fn()
    const { result, rerender } = renderHook(
      ({ host }) => useTaskPageJiraSavedFilters(model(host), setQuery),
      { initialProps: { host: 'host-a' } }
    )
    await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
    let oldWrite = Promise.resolve(false)
    act(() => {
      oldWrite = result.current.applyJiraSavedFilter(filter).catch(() => false)
    })
    rerender({ host: 'host-b' })
    await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
    rerender({ host: 'host-a' })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
    let newWrite = Promise.resolve(false)
    act(() => {
      newWrite = result.current.applyJiraSavedFilter(filter)
    })
    expect(result.current.jiraSavedFiltersPending).toBe(true)
    setQuery.mockClear()
    await act(async () => {
      settleOld()
      await oldWrite
    })
    expect(result.current.jiraSavedFilters).toEqual([filter])
    expect(result.current.jiraSavedFiltersPending).toBe(true)
    expect(result.current.jiraSavedFiltersError).toBeNull()
    expect(setQuery).not.toHaveBeenCalled()
    await act(async () => {
      settleNew()
      await newWrite
    })
    expect(result.current.jiraSavedFiltersPending).toBe(false)
    expect(setQuery).toHaveBeenCalledWith(filter.jql)
  }
)
it('applies only the committed owner while another owner render is suspended', async () => {
  read.mockResolvedValue(initial)
  mutate.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const suspended = new Promise(() => {})
  const { result, rerender } = renderHook(
    ({ host, suspend }) => {
      const filters = useTaskPageJiraSavedFilters(model(host), setQuery)
      if (suspend) {
        throw suspended
      }
      return filters
    },
    {
      initialProps: { host: 'host-a', suspend: false },
      wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense>
    }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  const committedAction = result.current.applyJiraSavedFilter
  act(() => {
    startTransition(() => rerender({ host: 'host-b', suspend: true }))
  })
  await act(async () => {
    expect(await committedAction(filter)).toBe(true)
  })
  expect(mutate).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    { kind: 'select', id: filter.id }
  )
  expect(read).toHaveBeenCalledTimes(1)
})
