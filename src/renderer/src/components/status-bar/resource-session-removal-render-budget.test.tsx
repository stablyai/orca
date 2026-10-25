// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'
import { useSyncExternalStore } from 'react'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('updates known exits cheaply and commits zero times for 1,000 inactive unknown lifecycle events', async () => {
  vi.useFakeTimers()
  const list = vi.fn(async () => [
    { id: 'known', incarnationId: 'A', title: 'Shell', cwd: '/', agentOwnership: 'absent' as const }
  ])
  const cache = new ResourceSessionInventoryCache(list, true)
  cache.setActive(true)
  await cache.refresh()
  await vi.advanceTimersByTimeAsync(100)
  cache.setActive(false)
  let renders = 0
  const view = renderHook(() => {
    renders++
    return useSyncExternalStore(cache.subscribe, cache.getSnapshot)
  })
  const baseline = view.result.current.sessionInventory
  const before = renders
  const calls = list.mock.calls.length
  for (let index = 0; index < 1_000; index++) {
    act(() => {
      cache.spawned({ id: `unknown-${index}`, incarnationId: 'A', hostId: 'local' })
      cache.exited({ code: 0, id: `unknown-${index}`, incarnationId: 'A', hostId: 'local' })
    })
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(renders - before).toBe(0)
  expect(view.result.current.sessionInventory).toBe(baseline)
  expect(list.mock.calls.length).toBe(calls)
  act(() => cache.exited({ code: 0, id: 'known', incarnationId: 'A', hostId: 'local' }))
  expect(view.result.current.sessionInventory.count).toBe(0)
  expect(renders - before).toBe(1)
})
