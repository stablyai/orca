// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKaneoUrlSource } from './use-kaneo-url-source'
import { lookupKaneoTask } from '@/runtime/runtime-kaneo-client'
import type { KaneoTask } from '../../../../shared/kaneo-types'

vi.mock('@/runtime/runtime-kaneo-client', () => ({ lookupKaneoTask: vi.fn() }))
const url = 'https://tasks.example.com/dashboard/workspace/ws/project/proj/task/one'
const getTask = vi.mocked(lookupKaneoTask)
const task = { url, title: 'First task' } as KaneoTask
beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe('Kaneo smart URL lookup', () => {
  it('does not query for ordinary text or when Smart input is disabled', async () => {
    const { rerender } = renderHook(
      ({ value, enabled }) => useKaneoUrlSource(value, enabled, null),
      { initialProps: { value: 'Fix booking', enabled: true } }
    )
    rerender({ value: url, enabled: false })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(getTask).not.toHaveBeenCalled()
  })

  it('clears stale results immediately and ignores a superseded request', async () => {
    let resolveFirst!: (task: KaneoTask) => void
    getTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    getTask.mockResolvedValueOnce({
      ...task,
      title: 'Second task',
      url: url.replace('/one', '/two')
    })
    const { result, rerender } = renderHook(({ value }) => useKaneoUrlSource(value, true, null), {
      initialProps: { value: url }
    })
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1))
    rerender({ value: url.replace('/one', '/two') })
    expect(result.current.task).toBeNull()
    await waitFor(() => expect(result.current.task?.title).toBe('Second task'))
    await act(async () => resolveFirst(task))
    expect(result.current.task?.title).toBe('Second task')
  })

  it('isolates results when switching runtime and supports retry after failure', async () => {
    getTask
      .mockResolvedValueOnce(task)
      .mockRejectedValueOnce(new Error('Update the selected Orca runtime'))
      .mockResolvedValueOnce(task)
    const { result, rerender } = renderHook(
      ({ environmentId }) =>
        useKaneoUrlSource(url, true, { activeRuntimeEnvironmentId: environmentId }),
      { initialProps: { environmentId: 'one' } }
    )
    await waitFor(() => expect(result.current.task).toEqual(task))
    rerender({ environmentId: 'two' })
    expect(result.current.task).toBeNull()
    await waitFor(() => expect(result.current.error).toContain('Update'))
    act(() => result.current.retry())
    expect(result.current.error).toBeNull()
    await waitFor(() => expect(result.current.task).toEqual(task))
    expect(lookupKaneoTask).toHaveBeenLastCalledWith(
      { activeRuntimeEnvironmentId: 'two' },
      url,
      expect.any(AbortSignal)
    )
  })
  it('does not revive a previous response when input or runtime returns to an earlier value', async () => {
    getTask.mockResolvedValueOnce(task).mockImplementation(() => new Promise(() => {}))
    const { result, rerender } = renderHook(
      ({ value, environmentId }) =>
        useKaneoUrlSource(value, true, { activeRuntimeEnvironmentId: environmentId }),
      { initialProps: { value: url, environmentId: 'one' } }
    )
    await waitFor(() => expect(result.current.task).toEqual(task))
    rerender({ value: url, environmentId: 'two' })
    rerender({ value: url, environmentId: 'one' })
    expect(result.current.task).toBeNull()
    expect(result.current.loading).toBe(true)
    rerender({ value: '', environmentId: 'one' })
    rerender({ value: url, environmentId: 'one' })
    expect(result.current.task).toBeNull()
  })
})
