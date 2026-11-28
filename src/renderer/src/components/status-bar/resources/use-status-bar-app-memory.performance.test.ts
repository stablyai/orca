// @vitest-environment happy-dom
// Perf contract for #51209: the status bar memory reading must not poll or keep a timer while
// the window is inactive, hidden or the setting is off.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STATUS_BAR_APP_MEMORY_POLL_MS, useStatusBarAppMemory } from './use-status-bar-app-memory'
import { advanceFakeTime, installFakeAppMemoryApi } from './status-bar-app-memory-fake-api'

const GB = 1024 * 1024 * 1024
let api: ReturnType<typeof installFakeAppMemoryApi>

beforeEach(() => {
  vi.useFakeTimers()
  api = installFakeAppMemoryApi(() => Promise.resolve(2 * GB))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('never subscribes, reads or keeps a timer while disabled', async () => {
  renderHook(() => useStatusBarAppMemory(false))
  await advanceFakeTime(10 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(api.activeListeners).toBe(0)
  expect(api.reads).toHaveBeenCalledTimes(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('reads once per interval only while active and keeps no timer otherwise', async () => {
  renderHook(() => useStatusBarAppMemory(true))
  await advanceFakeTime(STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(api.reads).toHaveBeenCalledTimes(0)
  act(() => api.setActive(true))
  await advanceFakeTime()
  expect(api.reads).toHaveBeenCalledTimes(1)
  await advanceFakeTime(3 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(api.reads).toHaveBeenCalledTimes(4)
  act(() => api.setActive(false))
  expect(vi.getTimerCount()).toBe(0)
  await advanceFakeTime(10 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(api.reads).toHaveBeenCalledTimes(4)
})

it('reads once when focus flaps within one interval', async () => {
  renderHook(() => useStatusBarAppMemory(true))
  act(() => api.setActive(true))
  await advanceFakeTime()
  for (let i = 0; i < 20; i++) {
    act(() => api.setActive(false))
    act(() => api.setActive(true))
    await advanceFakeTime(500)
  }
  expect(api.reads).toHaveBeenCalledTimes(1)
  act(() => api.setActive(false))
  await advanceFakeTime(STATUS_BAR_APP_MEMORY_POLL_MS)
  act(() => api.setActive(true))
  await advanceFakeTime()
  expect(api.reads).toHaveBeenCalledTimes(2)
})

it('keeps no timer while the document is hidden', async () => {
  renderHook(() => useStatusBarAppMemory(true))
  act(() => api.setActive(true))
  await advanceFakeTime()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(vi.getTimerCount()).toBe(0)
  await advanceFakeTime(5 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(api.reads).toHaveBeenCalledTimes(1)
  visibility.mockRestore()
})

it('turning it off live or unmounting drops the subscription and the timer', async () => {
  const hook = renderHook(({ enabled }) => useStatusBarAppMemory(enabled), {
    initialProps: { enabled: true }
  })
  act(() => api.setActive(true))
  await advanceFakeTime()
  hook.rerender({ enabled: false })
  await advanceFakeTime()
  expect(api.activeListeners).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  await advanceFakeTime(10 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(api.reads).toHaveBeenCalledTimes(1)

  hook.rerender({ enabled: true })
  act(() => api.setActive(true))
  await advanceFakeTime()
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
  expect(api.activeListeners).toBe(0)
})
