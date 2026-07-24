import { describe, expect, it, vi } from 'vitest'
import {
  getRepoSlugResolutionPoolStateForTests,
  MAX_REPO_SLUG_RESOLUTION_WAITERS,
  REPO_SLUG_RESOLUTION_CONCURRENCY,
  resolveRepoSlugsWithFixedWorkers
} from './repo-slug-resolution-pool'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((nextResolve) => {
      resolve = nextResolve
    }),
    resolve
  }
}

async function occupyAllSlots(gate: Promise<void>): Promise<(string | null)[]> {
  return resolveRepoSlugsWithFixedWorkers(
    Array.from({ length: REPO_SLUG_RESOLUTION_CONCURRENCY }, (_, index) => index),
    async (index) => {
      await gate
      return `owner/repo-${index}`
    }
  )
}

describe('repo slug resolution pool', () => {
  it('rejects one-over saturation without retaining another waiter', async () => {
    const activeGate = deferred()
    const active = occupyAllSlots(activeGate.promise)
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().active).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    )

    const controllers = Array.from(
      { length: MAX_REPO_SLUG_RESOLUTION_WAITERS },
      () => new AbortController()
    )
    const queued = controllers.map((controller, index) =>
      resolveRepoSlugsWithFixedWorkers(
        [index],
        async () => `owner/queued-${index}`,
        controller.signal
      )
    )
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(
        MAX_REPO_SLUG_RESOLUTION_WAITERS
      )
    )

    await expect(
      resolveRepoSlugsWithFixedWorkers([0], async () => 'owner/overflow')
    ).rejects.toThrow('Too many queued repo slug resolutions.')
    expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(MAX_REPO_SLUG_RESOLUTION_WAITERS)

    controllers.forEach((controller) => controller.abort())
    await expect(Promise.allSettled(queued)).resolves.toSatisfy((results) =>
      results.every((result) => result.status === 'rejected')
    )
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({
      active: REPO_SLUG_RESOLUTION_CONCURRENCY,
      waiters: 0
    })

    activeGate.resolve()
    await active
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({ active: 0, waiters: 0 })
  })

  it('releases an aborted waiter so later work can use its queue slot', async () => {
    const activeGate = deferred()
    const active = occupyAllSlots(activeGate.promise)
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().active).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    )

    const cancelledResolver = vi.fn(async () => 'owner/cancelled')
    const controller = new AbortController()
    const cancelled = resolveRepoSlugsWithFixedWorkers([0], cancelledResolver, controller.signal)
    await vi.waitFor(() => expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(1))
    controller.abort()
    await expect(cancelled).rejects.toThrow('Repo slug index resolution was cancelled.')
    expect(cancelledResolver).not.toHaveBeenCalled()
    expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(0)

    const replacementResolver = vi.fn(async () => 'owner/replacement')
    const replacement = resolveRepoSlugsWithFixedWorkers([0], replacementResolver)
    await vi.waitFor(() => expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(1))
    activeGate.resolve()

    await expect(replacement).resolves.toEqual(['owner/replacement'])
    await active
    expect(replacementResolver).toHaveBeenCalledOnce()
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({ active: 0, waiters: 0 })
  })

  it('removes partially admitted workers when their build hits the waiter cap', async () => {
    const activeGate = deferred()
    const active = occupyAllSlots(activeGate.promise)
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().active).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    )
    const controllers = Array.from(
      { length: MAX_REPO_SLUG_RESOLUTION_WAITERS - 1 },
      () => new AbortController()
    )
    const queued = controllers.map((controller, index) =>
      resolveRepoSlugsWithFixedWorkers(
        [index],
        async () => `owner/queued-${index}`,
        controller.signal
      )
    )
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(
        MAX_REPO_SLUG_RESOLUTION_WAITERS - 1
      )
    )

    await expect(
      resolveRepoSlugsWithFixedWorkers(
        Array.from({ length: REPO_SLUG_RESOLUTION_CONCURRENCY }, (_, index) => index),
        async (index) => `owner/overflow-${index}`
      )
    ).rejects.toThrow('Too many queued repo slug resolutions.')
    expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(
      MAX_REPO_SLUG_RESOLUTION_WAITERS - 1
    )

    controllers.forEach((controller) => controller.abort())
    await Promise.allSettled(queued)
    activeGate.resolve()
    await active
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({ active: 0, waiters: 0 })
  })

  it('releases a failed active slot and runs the oldest queued worker', async () => {
    const failureGate = deferred()
    const activeResolvers = Array.from({ length: REPO_SLUG_RESOLUTION_CONCURRENCY }, (_, index) =>
      resolveRepoSlugsWithFixedWorkers([index], async () => {
        await failureGate.promise
        if (index === 0) {
          throw new Error('resolution failed')
        }
        return `owner/active-${index}`
      })
    )
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().active).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    )
    const queuedResolver = vi.fn(async () => 'owner/queued')
    const queued = resolveRepoSlugsWithFixedWorkers([0], queuedResolver)
    await vi.waitFor(() => expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(1))

    failureGate.resolve()
    const activeResults = await Promise.allSettled(activeResolvers)
    await expect(queued).resolves.toEqual(['owner/queued'])

    expect(activeResults.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(queuedResolver).toHaveBeenCalledOnce()
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({ active: 0, waiters: 0 })
  })

  it('removes sibling waiters when one worker in their build fails', async () => {
    const activeGates = Array.from({ length: REPO_SLUG_RESOLUTION_CONCURRENCY }, deferred)
    const active = activeGates.map((gate, index) =>
      resolveRepoSlugsWithFixedWorkers([index], async () => {
        await gate.promise
        return `owner/active-${index}`
      })
    )
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().active).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    )

    const queuedResolver = vi.fn(async (index: number) => {
      if (index === 0) {
        throw new Error('queued resolution failed')
      }
      return `owner/queued-${index}`
    })
    const queued = resolveRepoSlugsWithFixedWorkers(
      Array.from({ length: REPO_SLUG_RESOLUTION_CONCURRENCY }, (_, index) => index),
      queuedResolver
    )
    await vi.waitFor(() =>
      expect(getRepoSlugResolutionPoolStateForTests().waiters).toBe(
        REPO_SLUG_RESOLUTION_CONCURRENCY
      )
    )

    activeGates[0].resolve()
    await expect(queued).rejects.toThrow('queued resolution failed')
    expect(queuedResolver).toHaveBeenCalledTimes(1)
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({
      active: REPO_SLUG_RESOLUTION_CONCURRENCY - 1,
      waiters: 0
    })

    activeGates.slice(1).forEach((gate) => gate.resolve())
    await Promise.all(active)
    expect(getRepoSlugResolutionPoolStateForTests()).toEqual({ active: 0, waiters: 0 })
  })
})
