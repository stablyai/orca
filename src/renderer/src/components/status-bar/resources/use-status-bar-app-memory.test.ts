// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STATUS_BAR_APP_MEMORY_POLL_MS, useStatusBarAppMemory } from './use-status-bar-app-memory'
import { advanceFakeTime, installFakeAppMemoryApi } from './status-bar-app-memory-fake-api'

const GB = 1024 * 1024 * 1024

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows nothing while disabled or before the window is first active', async () => {
  const api = installFakeAppMemoryApi(() => Promise.resolve(2 * GB))
  const disabled = renderHook(() => useStatusBarAppMemory(false))
  await advanceFakeTime(STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(disabled.result.current).toBeNull()
  disabled.unmount()

  const enabled = renderHook(() => useStatusBarAppMemory(true))
  await advanceFakeTime(STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(enabled.result.current).toBeNull()
  act(() => api.setActive(true))
  await advanceFakeTime()
  expect(enabled.result.current).toBe(2 * GB)
  act(() => api.setActive(false))
  // The last value stays visible while inactive.
  expect(enabled.result.current).toBe(2 * GB)
})

it('clears the value when turned off live', async () => {
  const api = installFakeAppMemoryApi(() => Promise.resolve(2 * GB))
  const hook = renderHook(({ enabled }) => useStatusBarAppMemory(enabled), {
    initialProps: { enabled: true }
  })
  act(() => api.setActive(true))
  await advanceFakeTime()
  expect(hook.result.current).toBe(2 * GB)
  hook.rerender({ enabled: false })
  expect(hook.result.current).toBeNull()
})

it('drops an answer that arrives after the setting was turned off', async () => {
  let resolveRead: (value: number) => void = () => {}
  const api = installFakeAppMemoryApi(
    () => new Promise<number>((resolve) => (resolveRead = resolve))
  )
  const hook = renderHook(({ enabled }) => useStatusBarAppMemory(enabled), {
    initialProps: { enabled: true }
  })
  act(() => api.setActive(true))
  await advanceFakeTime()
  hook.rerender({ enabled: false })
  hook.rerender({ enabled: true })
  resolveRead(5 * GB)
  await advanceFakeTime()
  expect(hook.result.current).toBeNull()
})

it('shows nothing for a failed, empty or invalid reading', async () => {
  for (const read of [
    () => Promise.reject(new Error('metrics unavailable')),
    () => Promise.resolve(0),
    () => Promise.resolve(Number.NaN),
    () => Promise.resolve(null)
  ]) {
    const api = installFakeAppMemoryApi(read)
    const hook = renderHook(() => useStatusBarAppMemory(true))
    act(() => api.setActive(true))
    await advanceFakeTime()
    expect(hook.result.current).toBeNull()
    hook.unmount()
  }
})
