import { describe, expect, it } from 'vitest'
import { PR_CHECK_LOG_TAIL_BYTES } from './check-job-log-excerpt'
import { PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR, sliceCheckLogTail } from './check-job-log-tail-slice'

describe('sliceCheckLogTail', () => {
  it('keeps earlier error context when the recent tail is larger than the byte cap', () => {
    const noisyPrefix = Array.from({ length: 120 }, (_, index) => `Installing package ${index}`)
    const failure = 'AssertionError: expected visible failure'
    const hugeRecentTail = Array.from(
      { length: 100 },
      (_, index) => `recent line ${index} ${'x'.repeat(300)}`
    )
    const sliced = sliceCheckLogTail([...noisyPrefix, failure, ...hugeRecentTail].join('\n'))

    expect(sliced).toContain(failure)
    expect(sliced).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
    expect(sliced).toContain('recent line 99')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })
})
