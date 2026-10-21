import { describe, expect, it } from 'vitest'
import {
  WATCH_BATCH_INTERVAL_MS,
  WATCH_BATCH_LEADING_MS,
  watchBatchFlushDelayMs
} from './filesystem-watch-batch-window'

describe('watchBatchFlushDelayMs', () => {
  it('uses the leading delay before the first flush', () => {
    expect(watchBatchFlushDelayMs(1_000_000, 0)).toBe(WATCH_BATCH_LEADING_MS)
  })

  it('uses the leading delay once a full interval has passed', () => {
    expect(watchBatchFlushDelayMs(1_000 + WATCH_BATCH_INTERVAL_MS, 1_000)).toBe(
      WATCH_BATCH_LEADING_MS
    )
  })

  it('waits out the rest of the interval after a recent flush', () => {
    expect(watchBatchFlushDelayMs(1_010, 1_000)).toBe(WATCH_BATCH_INTERVAL_MS - 10)
  })

  it('never returns less than the leading delay', () => {
    expect(watchBatchFlushDelayMs(1_090, 1_000)).toBe(WATCH_BATCH_LEADING_MS)
  })

  it('never waits longer than one interval when the clock moves backwards', () => {
    expect(watchBatchFlushDelayMs(1_000, 3_600_000)).toBe(WATCH_BATCH_INTERVAL_MS)
  })

  it('honours custom windows', () => {
    expect(watchBatchFlushDelayMs(1_000, 950, 5, 200)).toBe(150)
  })
})
