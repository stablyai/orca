// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { startTransition, Suspense } from 'react'
import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import {
  LOCAL_EXECUTION_HOST_ID,
  UNRESOLVED_OWNER_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
const { read, mutate } = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }))
vi.mock('@/runtime/runtime-jira-saved-filter-state', () => ({
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
it('uses the captured account owner without a source context and keeps source ownership first', async () => {
  read.mockResolvedValue(initial)
  mutate.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ sourceHost }) => useTaskPageJiraSavedFilters(model(sourceHost), setQuery),
    { initialProps: { sourceHost: '' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'account-owner' })
  await act(async () => result.current.applyJiraSavedFilter(filter))
  expect(mutate).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'account-owner' },
    { kind: 'select', id: filter.id }
  )
  rerender({ sourceHost: 'source-owner' })
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'source-owner' })
})
it('does not load or write filters for an unresolved owner', async () => {
  const { result } = renderHook(() =>
    useTaskPageJiraSavedFilters(
      { ...model(null), accountBackedTaskSourceHostId: UNRESOLVED_OWNER_HOST_ID },
      vi.fn()
    )
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  await act(async () => result.current.applyJiraSavedFilter(filter))
  expect(result.current.jiraSavedFiltersReady).toBe(false)
  expect(read).not.toHaveBeenCalled()
  expect(mutate).not.toHaveBeenCalled()
})
it('separates local ownership from a runtime environment named local', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ remote }) =>
      useTaskPageJiraSavedFilters(
        {
          ...model(null),
          accountBackedTaskSourceHostId: remote ? 'runtime:local' : LOCAL_EXECUTION_HOST_ID
        },
        setQuery
      ),
    { initialProps: { remote: false } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  expect(read).toHaveBeenLastCalledWith({ kind: 'local' })
  rerender({ remote: true })
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'local' })
  )
})
it('restores the host selection and reruns its exact JQL after remount', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const first = renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(first.result.current.jiraSavedFiltersReady).toBe(true))
  expect(setQuery).toHaveBeenCalledWith(filter.jql)
  first.unmount()
  setQuery.mockClear()
  renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(setQuery).toHaveBeenCalledWith(filter.jql))
})
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
it('ignores a late write response from an owner that was left', async () => {
  read.mockResolvedValueOnce(initial).mockResolvedValueOnce({ filters: [], activeFilterId: null })
  let resolveWrite: (value: typeof initial) => void = () => {}
  mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveWrite = resolve
      })
  )
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ host }) => useTaskPageJiraSavedFilters(model(host), setQuery),
    { initialProps: { host: 'host-a' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  let pending = Promise.resolve(false)
  act(() => {
    pending = result.current.applyJiraSavedFilter(filter)
  })
  rerender({ host: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersPending).toBe(false))
  setQuery.mockClear()
  await act(async () => {
    resolveWrite(initial)
    await pending
  })
  expect(result.current.jiraSavedFilters).toEqual([])
  expect(setQuery).not.toHaveBeenCalled()
})
it('does not send a saved filter action retained from a previous account owner', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ accountHost }) => useTaskPageJiraSavedFilters(model(null, accountHost), setQuery),
    { initialProps: { accountHost: 'host-a' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  const oldAction = result.current.applyJiraSavedFilter
  rerender({ accountHost: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await act(async () => oldAction(filter))
  expect(mutate).not.toHaveBeenCalled()
})
it('retains stored JQL after failed writes and clears only selection for manual editing', async () => {
  read.mockResolvedValue(initial)
  mutate.mockRejectedValueOnce(new Error('Host disconnected'))
  const setQuery = vi.fn()
  const { result } = renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await act(async () => {
    await expect(
      result.current.updateJiraSavedFilter(filter.id, { name: 'New name', jql: 'invalid' })
    ).rejects.toThrow('Host disconnected')
  })
  expect(result.current.jiraSavedFilters).toEqual([filter])
  mutate.mockResolvedValueOnce({ filters: [filter], activeFilterId: null })
  setQuery.mockClear()
  await act(async () => {
    await result.current.clearJiraSavedFilterSelection()
  })
  expect(mutate).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    { kind: 'select', id: null }
  )
  expect(setQuery).not.toHaveBeenCalled()
})
it('rejects a saved-filter action retained from a previous visit to the same owner', async () => {
  read.mockResolvedValue(initial)
  mutate.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ host }) => useTaskPageJiraSavedFilters(model(host), setQuery),
    { initialProps: { host: 'host-a' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  const oldAction = result.current.applyJiraSavedFilter
  rerender({ host: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  rerender({ host: 'host-a' })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  await act(async () => oldAction(filter))
  expect(mutate).not.toHaveBeenCalled()
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
it('reports false for skipped, stale, or unapplied selections and true only after applying JQL', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, unmount } = renderHook(() =>
    useTaskPageJiraSavedFilters(model('host-a'), setQuery)
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  setQuery.mockClear()
  mutate.mockResolvedValueOnce({ filters: [filter], activeFilterId: null })
  await act(async () => {
    expect(await result.current.applyJiraSavedFilter(filter)).toBe(false)
  })
  expect(setQuery).not.toHaveBeenCalled()
  let resolveApply: (value: typeof initial) => void = () => {}
  mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveApply = resolve
      })
  )
  let applying = Promise.resolve(false)
  act(() => {
    applying = result.current.applyJiraSavedFilter(filter)
  })
  await act(async () => {
    expect(await result.current.applyJiraSavedFilter(filter)).toBe(false)
  })
  unmount()
  resolveApply(initial)
  expect(await applying).toBe(false)
  expect(setQuery).not.toHaveBeenCalled()
  expect(mutate).toHaveBeenCalledTimes(2)
})
it('validates a stale clear callback against the latest confirmed selection', async () => {
  read.mockResolvedValue({ filters: [filter], activeFilterId: null })
  const setQuery = vi.fn()
  const { result } = renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  const clear = result.current.clearJiraSavedFilterSelection
  mutate
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ filters: [filter], activeFilterId: null })
  await act(async () => expect(await result.current.applyJiraSavedFilter(filter)).toBe(true))
  await act(async () => expect(await clear()).toBe(true))
  expect(mutate).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    { kind: 'select', id: null }
  )
})
