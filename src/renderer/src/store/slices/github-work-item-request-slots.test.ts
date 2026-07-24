import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import {
  GITHUB_WORK_ITEM_FETCH_CONCURRENCY,
  GITHUB_WORK_ITEM_FETCH_MAX_WAITERS,
  GitHubWorkItemRequestSlots
} from './github-work-item-request-slots'

describe('GitHub work-item request slots', () => {
  it('rejects the 257th waiter, drains FIFO across compaction, and recovers', async () => {
    const slots = new GitHubWorkItemRequestSlots()
    await Promise.all(
      Array.from({ length: GITHUB_WORK_ITEM_FETCH_CONCURRENCY }, () => slots.acquire())
    )
    const started: number[] = []
    const waiters = Array.from({ length: GITHUB_WORK_ITEM_FETCH_MAX_WAITERS }, (_, index) =>
      slots.acquire().then(() => {
        started.push(index)
        slots.release()
      })
    )

    await expect(slots.acquire()).rejects.toThrow('GitHub work-item request queue is full')
    for (let index = 0; index < GITHUB_WORK_ITEM_FETCH_CONCURRENCY; index += 1) {
      slots.release()
    }
    await Promise.all(waiters)

    expect(started).toEqual(
      Array.from({ length: GITHUB_WORK_ITEM_FETCH_MAX_WAITERS }, (_, index) => index)
    )
    await expect(slots.acquire()).resolves.toBeUndefined()
    slots.release()
  })

  it('processes 10,000 repositories with eight workers and preserves result order', async () => {
    const slots = new GitHubWorkItemRequestSlots()
    let active = 0
    let peak = 0
    const repoIndexes = Array.from({ length: 10_000 }, (_, index) => index)

    const results = await mapWithConcurrency(
      repoIndexes,
      GITHUB_WORK_ITEM_FETCH_CONCURRENCY,
      async (index) => {
        await slots.acquire()
        try {
          active += 1
          peak = Math.max(peak, active)
          await Promise.resolve()
          return index
        } finally {
          active -= 1
          slots.release()
        }
      }
    )

    expect(peak).toBe(GITHUB_WORK_ITEM_FETCH_CONCURRENCY)
    expect(results).toEqual(repoIndexes)
  })
})
