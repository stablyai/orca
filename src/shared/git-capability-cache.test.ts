import { describe, expect, it, vi } from 'vitest'
import { GIT_CAPABILITY_RETRY_INTERVAL_MS, GitCapabilityCache } from './git-capability-cache'

describe('GitCapabilityCache', () => {
  it('retries a capability after the compatibility interval', () => {
    const cache = new GitCapabilityCache()
    cache.rememberUnsupported('worktree-list-z', 1_000)

    expect(cache.shouldTry('worktree-list-z', 1_000 + GIT_CAPABILITY_RETRY_INTERVAL_MS - 1)).toBe(
      false
    )
    expect(cache.shouldTry('worktree-list-z', 1_000 + GIT_CAPABILITY_RETRY_INTERVAL_MS)).toBe(true)
  })

  it('coalesces concurrent capability probes after an unsupported result', async () => {
    const cache = new GitCapabilityCache()
    let rejectProbe!: (error: Error) => void
    const firstPreferred = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectProbe = reject
        })
    )
    const secondPreferred = vi.fn(async () => 'unexpected')
    const firstFallback = vi.fn(async () => 'first-fallback')
    const secondFallback = vi.fn(async () => 'second-fallback')
    const isUnsupported = (error: unknown): boolean =>
      error instanceof Error && error.message === 'unsupported'

    const first = cache.runWithFallback(
      'for-each-ref-exclude',
      firstPreferred,
      firstFallback,
      isUnsupported
    )
    const second = cache.runWithFallback(
      'for-each-ref-exclude',
      secondPreferred,
      secondFallback,
      isUnsupported
    )
    rejectProbe(new Error('unsupported'))

    await expect(Promise.all([first, second])).resolves.toEqual([
      'first-fallback',
      'second-fallback'
    ])
    expect(firstPreferred).toHaveBeenCalledTimes(1)
    expect(secondPreferred).not.toHaveBeenCalled()
    expect(firstFallback).toHaveBeenCalledTimes(1)
    expect(secondFallback).toHaveBeenCalledTimes(1)
  })

  it('does not serialize calls after a capability is known to be supported', async () => {
    const cache = new GitCapabilityCache()
    const isUnsupported = vi.fn(() => false)
    await cache.runWithFallback(
      'for-each-ref-exclude',
      async () => 'initial-result',
      async () => 'unexpected-fallback',
      isUnsupported
    )

    const releases: (() => void)[] = []
    let activeCalls = 0
    let maxConcurrentCalls = 0
    const runPreferred = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          activeCalls += 1
          maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls)
          releases.push(() => {
            activeCalls -= 1
            resolve('result')
          })
        })
    )

    const first = cache.runWithFallback(
      'for-each-ref-exclude',
      runPreferred,
      async () => 'unexpected-fallback',
      isUnsupported
    )
    const second = cache.runWithFallback(
      'for-each-ref-exclude',
      runPreferred,
      async () => 'unexpected-fallback',
      isUnsupported
    )

    expect(runPreferred).toHaveBeenCalledTimes(2)
    expect(maxConcurrentCalls).toBe(2)
    for (const release of releases) {
      release()
    }
    await expect(Promise.all([first, second])).resolves.toEqual(['result', 'result'])
  })

  it('drops known support when a later call reports the capability unsupported', async () => {
    const cache = new GitCapabilityCache()
    const isUnsupported = (error: unknown): boolean =>
      error instanceof Error && error.message === 'unsupported'
    await cache.runWithFallback(
      'for-each-ref-exclude',
      async () => 'supported',
      async () => 'unexpected-fallback',
      isUnsupported
    )

    await expect(
      cache.runWithFallback(
        'for-each-ref-exclude',
        async () => {
          throw new Error('unsupported')
        },
        async () => 'fallback',
        isUnsupported
      )
    ).resolves.toBe('fallback')

    const laterPreferred = vi.fn(async () => 'unexpected-preferred')
    await expect(
      cache.runWithFallback(
        'for-each-ref-exclude',
        laterPreferred,
        async () => 'cached-fallback',
        isUnsupported
      )
    ).resolves.toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })
})
