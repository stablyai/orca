// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCommanderPageSummaries } from './use-commander-page-summaries'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('lets a slow poll finish, retries errors, and discards superseded manual and account reads', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const slow = Promise.withResolvers<unknown>()
  const old = Promise.withResolvers<unknown>()
  const manual = Promise.withResolvers<unknown>()
  const index = vi
    .fn()
    .mockReturnValueOnce(slow.promise)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(manual.promise)
    .mockResolvedValue({ pages: [{ pageId: 'new-account-page' }] })
  vi.stubGlobal('api', { commanderMemory: { index } })
  const account = { profileId: 'p', userId: 'u', activeOrgId: 'first' }
  const ids = ['page']
  const { result, rerender } = renderHook((owner) => useCommanderPageSummaries(owner, ids), {
    initialProps: account
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(index).toHaveBeenCalledTimes(1)
  await act(async () => slow.reject(new Error('Unavailable')))
  expect(result.current.error).toBe('Unavailable')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(index).toHaveBeenCalledTimes(2)
  act(() => {
    void result.current.refresh()
  })
  await act(async () => old.resolve({ pages: [{ pageId: 'stale-poll' }] }))
  expect(result.current.pages).toEqual([])
  await act(async () => rerender({ ...account, activeOrgId: 'second' }))
  await act(async () => manual.resolve({ pages: [{ pageId: 'stale-account' }] }))
  expect(result.current.pages).toEqual([{ pageId: 'new-account-page' }])
})
