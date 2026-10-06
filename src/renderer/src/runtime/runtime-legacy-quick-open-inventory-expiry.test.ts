import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileListResult } from '../../../shared/runtime-types'
import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'
import {
  clearLegacyQuickOpenInventoryCacheForTests,
  hasCachedLegacyQuickOpenInventory,
  searchLegacyQuickOpenInventory
} from './runtime-legacy-quick-open-inventory'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const { call } = vi.hoisted(() => ({
  call: vi.fn<
    (
      target: unknown,
      method: string,
      params: unknown,
      options?: { signal?: AbortSignal }
    ) => Promise<RuntimeFileListResult>
  >()
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: call }))

const target = { kind: 'environment', environmentId: 'host-1' } as const

function search(worktree = 'one', signal?: AbortSignal) {
  return searchLegacyQuickOpenInventory({
    target,
    worktreeSelector: worktree,
    worktreePath: `/folder/projects/${worktree}`,
    query: 'src',
    limit: 2,
    excludePaths: undefined,
    signal
  })
}

function cached(worktree = 'one'): boolean {
  return hasCachedLegacyQuickOpenInventory(target, worktree, `/folder/projects/${worktree}`)
}

function listing(worktree = 'one', count = 3): RuntimeFileListResult {
  return {
    worktree,
    rootPath: `/folder/projects/${worktree}`,
    files: Array.from({ length: count }, (_, index) => ({
      relativePath: `src/feature-${index}/component.ts`,
      basename: 'component.ts',
      kind: 'text'
    })),
    totalCount: count,
    truncated: false
  }
}

function queueLoad() {
  const pending = Promise.withResolvers<RuntimeFileListResult>()
  call.mockReturnValueOnce(pending.promise)
  return pending
}

async function collectInventories(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(0)
  clearLegacyQuickOpenInventoryCacheForTests()
  replaceRuntimeEnvironmentRevisions([{ id: target.environmentId, createdAt: 1 }])
  call.mockReset()
})

afterEach(() => {
  clearLegacyQuickOpenInventoryCacheForTests()
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('legacy Quick Open inventory expiry', () => {
  it('releases an idle 5,000-file response at its deadline without another lookup', async () => {
    async function populate() {
      const response = listing('one', 5_000)
      const retired = new WeakRef(response)
      call.mockImplementationOnce(async () => response)
      expect(await search()).toEqual({
        files: ['src/feature-0/component.ts', 'src/feature-1/component.ts'],
        truncated: true
      })
      call.mockReset()
      return retired
    }

    const retired = await populate()
    await collectInventories()
    expect(retired.deref()).toBeDefined()
    vi.advanceTimersByTime(30_000)
    await collectInventories()
    expect(retired.deref()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one timer and strict expiry without renewing it on cache hits', async () => {
    call.mockImplementation(async () => listing())
    const first = await search()
    vi.advanceTimersByTime(29_999)
    expect(cached()).toBe(true)
    expect(await search()).toEqual(first)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(cached()).toBe(false)
    expect(await search()).toEqual(first)
    expect(call).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('starts the settled deadline when the inventory arrives', async () => {
    const load = queueLoad()
    const pending = search()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5_000)
    load.resolve(listing())
    await pending
    vi.advanceTimersByTime(29_999)
    expect(cached()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(cached()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sweeps settled responses while leaving shared pending loads valid', async () => {
    call.mockResolvedValueOnce(listing('settled'))
    await search('settled')
    vi.advanceTimersByTime(1_000)
    const load = queueLoad()
    const pending = search('pending')
    vi.advanceTimersByTime(29_000)
    expect(cached('pending')).toBe(true)
    const shared = search('pending')
    expect(call).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    load.resolve(listing('pending'))
    expect(await shared).toEqual(await pending)
    expect(cached('pending')).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('preserves LRU access order without extending the accessed entry deadline', async () => {
    call.mockImplementation(async () => listing())
    for (let index = 0; index < 8; index += 1) {
      await search(`scope-${index}`)
    }
    await search('scope-0')
    await search('scope-8')
    expect(cached('scope-0')).toBe(true)
    expect(cached('scope-1')).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(30_000)
    expect(cached('scope-0')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cleared', 'evicted'])(
    'keeps a late %s load valid without restoring its cache entry',
    async (action) => {
      const load = queueLoad()
      const pending = search()
      if (action === 'cleared') {
        clearLegacyQuickOpenInventoryCacheForTests()
      } else {
        call.mockImplementation(async () => listing())
        for (let index = 0; index < 8; index += 1) {
          await search(`scope-${index}`)
        }
        vi.advanceTimersByTime(30_000)
      }
      load.resolve(listing())
      expect(await pending).toEqual({
        files: ['src/feature-0/component.ts', 'src/feature-1/component.ts'],
        truncated: true
      })
      expect(cached()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps shared work alive after one consumer aborts', async () => {
    const load = queueLoad()
    const first = new AbortController()
    const second = new AbortController()
    const detached = search('one', first.signal)
    const remaining = search('one', second.signal)
    const rejected = expect(detached).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    await rejected
    expect(call.mock.calls[0][3]?.signal?.aborted).toBe(false)
    load.resolve(listing())
    await remaining
    expect(cached()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('aborts abandoned work and does not retain a response that arrives later', async () => {
    const load = queueLoad()
    const first = new AbortController()
    const second = new AbortController()
    const rejections = Promise.all([
      expect(search('one', first.signal)).rejects.toMatchObject({ name: 'AbortError' }),
      expect(search('one', second.signal)).rejects.toMatchObject({ name: 'AbortError' })
    ])
    first.abort()
    second.abort()
    await rejections
    expect(call.mock.calls[0][3]?.signal?.aborted).toBe(true)
    load.resolve(listing())
    await Promise.resolve()
    await Promise.resolve()
    expect(cached()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not remove a replacement when an expired pending request fails', async () => {
    const old = queueLoad()
    const stale = search()
    vi.advanceTimersByTime(30_000)
    const current = queueLoad()
    const pending = search()
    const rejected = expect(stale).rejects.toThrow('old host failed')
    old.reject(new Error('old host failed'))
    await rejected
    current.resolve(listing())
    const result = await pending
    expect(await search()).toEqual(result)
    expect(call).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('retries failed requests without keeping an expiry timer for their response', async () => {
    call.mockRejectedValueOnce(new Error('host failed'))
    await expect(search()).rejects.toThrow('host failed')
    expect(cached()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    call.mockResolvedValueOnce(listing())
    await search()
    expect(cached()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('replaces a longer armed deadline after a backward clock change and a new settlement', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    call.mockImplementation(async () => listing())
    await search()
    vi.setSystemTime(-100_000)
    vi.advanceTimersByTime(30_000)
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 100_000)
    vi.advanceTimersByTime(1_000)
    await search('two')
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 30_000)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(29_999)
    expect(cached('two')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(cached('two')).toBe(false)
    expect(cached()).toBe(true)
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 69_000)
    vi.advanceTimersByTime(69_000)
    expect(cached()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clamps backward-clock delays and reschedules the remaining deadline', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    call.mockResolvedValueOnce(listing())
    await search()
    vi.setSystemTime(-(MAX_TIMER_DELAY_MS + 90_000))
    vi.advanceTimersByTime(30_000)
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    expect(cached()).toBe(true)
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 90_000)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(90_000)
    expect(cached()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
