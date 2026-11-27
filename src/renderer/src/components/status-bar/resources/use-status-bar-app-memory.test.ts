// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STATUS_BAR_APP_MEMORY_POLL_MS, useStatusBarAppMemory } from './use-status-bar-app-memory'

const GB = 1024 * 1024 * 1024
let setActive: (active: boolean) => void = () => {}
let activeListeners = 0
let reads: ReturnType<typeof vi.fn>

function installApi(read: () => Promise<number | null>): void {
  reads = vi.fn(read)
  activeListeners = 0
  vi.stubGlobal('api', {
    ui: {
      isWindowActive: () => Promise.resolve(false),
      onWindowActiveChanged: (callback: (active: boolean) => void) => {
        activeListeners++
        setActive = callback
        return () => {
          activeListeners--
        }
      }
    },
    memory: { getAppMemoryTotal: reads }
  })
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  installApi(() => Promise.resolve(2 * GB))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('never subscribes, polls or shows a value while disabled', async () => {
  const hook = renderHook(() => useStatusBarAppMemory(false))
  await flush(10 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(activeListeners).toBe(0)
  expect(reads).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(hook.result.current).toBeNull()
})

it('samples only while the window is active and keeps no timer otherwise', async () => {
  const hook = renderHook(() => useStatusBarAppMemory(true))
  await flush()
  expect(reads).not.toHaveBeenCalled()
  expect(hook.result.current).toBeNull()

  act(() => setActive(true))
  await flush()
  expect(reads).toHaveBeenCalledTimes(1)
  expect(hook.result.current).toBe(2 * GB)
  await flush(3 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(reads).toHaveBeenCalledTimes(4)

  act(() => setActive(false))
  expect(vi.getTimerCount()).toBe(0)
  await flush(10 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(reads).toHaveBeenCalledTimes(4)
  // The last value stays visible while inactive.
  expect(hook.result.current).toBe(2 * GB)
})

it('does not re-read when focus flaps within one interval', async () => {
  renderHook(() => useStatusBarAppMemory(true))
  act(() => setActive(true))
  await flush()
  for (let i = 0; i < 20; i++) {
    act(() => setActive(false))
    act(() => setActive(true))
    await flush(500)
  }
  expect(reads).toHaveBeenCalledTimes(1)
  act(() => setActive(false))
  await flush(STATUS_BAR_APP_MEMORY_POLL_MS)
  act(() => setActive(true))
  await flush()
  expect(reads).toHaveBeenCalledTimes(2)
})

it('stops polling while the document is hidden', async () => {
  renderHook(() => useStatusBarAppMemory(true))
  act(() => setActive(true))
  await flush()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(vi.getTimerCount()).toBe(0)
  await flush(5 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(reads).toHaveBeenCalledTimes(1)
  visibility.mockRestore()
})

it('turning it off live clears the value, unsubscribes and stops the timer', async () => {
  const hook = renderHook(({ enabled }) => useStatusBarAppMemory(enabled), {
    initialProps: { enabled: true }
  })
  act(() => setActive(true))
  await flush()
  expect(hook.result.current).toBe(2 * GB)

  hook.rerender({ enabled: false })
  await flush()
  expect(hook.result.current).toBeNull()
  expect(activeListeners).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  await flush(10 * STATUS_BAR_APP_MEMORY_POLL_MS)
  expect(reads).toHaveBeenCalledTimes(1)
})

it('drops an answer that arrives after the setting was turned off', async () => {
  let resolveRead: (value: number) => void = () => {}
  installApi(() => new Promise<number>((resolve) => (resolveRead = resolve)))
  const hook = renderHook(({ enabled }) => useStatusBarAppMemory(enabled), {
    initialProps: { enabled: true }
  })
  act(() => setActive(true))
  await flush()
  hook.rerender({ enabled: false })
  hook.rerender({ enabled: true })
  resolveRead(5 * GB)
  await flush()
  expect(hook.result.current).toBeNull()
})

it('shows nothing for a failed, empty or invalid reading', async () => {
  for (const read of [
    () => Promise.reject(new Error('metrics unavailable')),
    () => Promise.resolve(0),
    () => Promise.resolve(Number.NaN),
    () => Promise.resolve(null)
  ]) {
    installApi(read)
    const hook = renderHook(() => useStatusBarAppMemory(true))
    act(() => setActive(true))
    await flush()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(hook.result.current).toBeNull()
    hook.unmount()
  }
})

it('leaves no timer or subscription after unmount', async () => {
  const hook = renderHook(() => useStatusBarAppMemory(true))
  act(() => setActive(true))
  await flush()
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
  expect(activeListeners).toBe(0)
})
