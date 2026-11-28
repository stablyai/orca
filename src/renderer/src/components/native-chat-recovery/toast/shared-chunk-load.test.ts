import { beforeEach, expect, it, vi } from 'vitest'
import type { LazyWithRetryOptions } from '@/app-shell/startup/lazy-with-retry'

type Load = { options: LazyWithRetryOptions; settle: (ok: boolean) => void }
const loads: Load[] = []

vi.mock('@/app-shell/startup/lazy-with-retry', () => ({
  loadLazyWithRetry: (_factory: unknown, options: LazyWithRetryOptions) =>
    new Promise((resolve, reject) => {
      loads.push({
        options,
        settle: (ok) => (ok ? resolve({ default: () => null }) : reject(new Error('chunk failed')))
      })
    })
}))

const { createSharedChunkLoad } = await import('./shared-chunk-load')
const request = (): ReturnType<ReturnType<typeof createSharedChunkLoad>> => shared()
let shared: ReturnType<typeof createSharedChunkLoad>

beforeEach(() => {
  loads.length = 0
  shared = createSharedChunkLoad(() => Promise.resolve({ default: () => null }), 'test-chunk')
})

it('loads once however many hosts ask', () => {
  request()
  request()
  expect(loads).toHaveLength(1)
})

it('may reload while one of two hosts still waits, and not once the last has gone', () => {
  const first = request()
  const second = request()
  first.release()
  expect(loads[0]!.options.canRecover?.()).toBe(true)
  second.release()
  expect(loads[0]!.options.canRecover?.()).toBe(false)
})

it('a host that arrives after the others left can recover the same load again', () => {
  request().release()
  request()
  expect(loads).toHaveLength(1)
  expect(loads[0]!.options.canRecover?.()).toBe(true)
})

it('forgets a failed load so the next request tries again, and keeps a successful one', async () => {
  const failed = request()
  loads[0]!.settle(false)
  await expect(failed.loaded).rejects.toThrow('chunk failed')
  const retried = request()
  expect(loads).toHaveLength(2)
  loads[1]!.settle(true)
  await retried.loaded
  request()
  expect(loads).toHaveLength(2)
})
