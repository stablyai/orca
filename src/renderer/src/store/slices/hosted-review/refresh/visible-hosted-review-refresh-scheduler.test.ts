// #46567: a selected row whose read keeps failing (no gh on a WSL host) retries as a poll.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createVisibleHostedReviewRefreshScheduler,
  type VisibleHostedReviewRefreshTarget
} from './visible-hosted-review-refresh-scheduler'

afterEach(() => {
  vi.useRealTimers()
})

describe('the visible review refresh scheduler', () => {
  it('sends a failed selected read once as discovery, then its retries as polls', async () => {
    vi.useFakeTimers()
    const reads: (string | undefined)[] = []
    const target: VisibleHostedReviewRefreshTarget = {
      key: 'repo::feature',
      revision: 'head-1',
      fetchedAt: null,
      intervalMs: 60_000,
      selected: true,
      refresh: async (_force, _signal, intent) => {
        reads.push(intent)
        return false
      }
    }
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    scheduler.setVisible(true)
    scheduler.update([target])
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    scheduler.dispose()

    expect(reads.length).toBeGreaterThan(1)
    expect(reads[0]).toBe('discovery')
    expect(new Set(reads.slice(1))).toEqual(new Set(['retry']))
  })
})
