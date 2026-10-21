// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkInbox } from './use-work-inbox'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
const list = vi.hoisted(() => vi.fn())
vi.mock('./work-inbox-client', () => ({
  listWorkInbox: list,
  workInboxTargetKey: () => 'local',
  answerWorkInboxItem: vi.fn(),
  changeWorkInboxStatus: vi.fn()
}))
const target: RuntimeClientTarget = { kind: 'local' }
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  list.mockReset()
})
it('polls only while open and refreshes when reopened', async () => {
  vi.useFakeTimers()
  list.mockResolvedValue({ items: [], openCount: 0 })
  const hook = renderHook(({ open }) => useWorkInbox({ open, target }), {
    initialProps: { open: false }
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).not.toHaveBeenCalled()
  await act(async () => hook.rerender({ open: true }))
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => hook.rerender({ open: false }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => hook.rerender({ open: true }))
  expect(list).toHaveBeenCalledTimes(3)
})
it('stops automatic retries for an unsupported host but permits explicit refresh', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  list.mockRejectedValue({ code: 'method_not_found' })
  const hook = renderHook(() => useWorkInbox({ open: true, target }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).toHaveBeenCalledTimes(1)
  expect(hook.result.current.loadError).toBe('unsupported')
  list.mockResolvedValue({ items: [], openCount: 0 })
  await act(async () => hook.result.current.reload())
  expect(hook.result.current.loadError).toBeNull()
})
