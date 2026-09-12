import { describe, expect, it, vi } from 'vitest'
import {
  PR_CHECK_LOG_TAIL_BYTES,
  PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR,
  PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES,
  sliceCheckLogTail
} from './check-job-log-tail-slice'

describe('sliceCheckLogTail', () => {
  it('keeps the recent tail when no earlier error markers are present', () => {
    const logLines = Array.from({ length: 210 }, (_, index) => `line ${index}`)
    const sliced = sliceCheckLogTail(logLines.join('\n'))

    expect(sliced).toContain('line 209')
    expect(sliced).not.toContain('line 0')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('pulls earlier error lines into the excerpt when the recent tail is noisy', () => {
    const noisyPrefix = Array.from({ length: 120 }, (_, index) => `Setting up package-${index}`)
    const failure = '##[error]Process completed with exit code 236.'
    const noisySuffix = Array.from({ length: 100 }, (_, index) => `Running trigger ${index}`)
    const sliced = sliceCheckLogTail([...noisyPrefix, failure, ...noisySuffix].join('\n'))

    expect(sliced).toContain(failure)
    expect(sliced).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
    expect(sliced).toContain('Running trigger 39')
    expect(sliced).not.toContain('Setting up package-0')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('still applies the byte cap after combining earlier errors with the recent tail', () => {
    const logLines = Array.from({ length: 220 }, (_, index) => `line ${index} ${'x'.repeat(120)}`)
    const sliced = sliceCheckLogTail(logLines.join('\n'))

    expect(sliced).toContain('line 219')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

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

  it('stops searching once the most recent error context fills the excerpt', () => {
    const earlier = Array.from({ length: 10_000 }, (_, index) => `error: failure ${index}`)
    const recent = Array.from({ length: 100 }, (_, index) => `recent ${index}`)
    const test = vi.spyOn(RegExp.prototype, 'test')
    let sliced: string
    let scanned: number
    try {
      sliced = sliceCheckLogTail([...earlier, ...recent].join('\n'))
      scanned = test.mock.calls.length
    } finally {
      test.mockRestore()
    }

    expect(sliced).toBe(
      [...earlier.slice(-30), PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR, ...recent].join('\n')
    )
    expect(scanned).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES)
  })

  it('deduplicates overlapping windows and clips the oldest window at 30 lines', () => {
    const earlier = Array.from({ length: 80 }, (_, index) => `line ${index}`)
    for (const index of [2, 3, 20, 21, 35, 44, 53, 62, 71]) {
      earlier[index] = `FAILED ${index}`
    }
    const recent = Array.from({ length: 100 }, (_, index) => `recent ${index}`)
    const expectedIndexes = [
      23,
      ...[35, 44, 53, 62, 71].flatMap((index) => [
        index - 2,
        index - 1,
        index,
        index + 1,
        index + 2
      ])
    ]
    // The overlapping errors at 20 and 21 contribute four more retained lines.
    expectedIndexes.unshift(19, 20, 21, 22)

    expect(sliceCheckLogTail([...earlier, ...recent].join('\r\n'))).toBe(
      [
        ...expectedIndexes.map((index) => earlier[index]),
        PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR,
        ...recent
      ].join('\n')
    )
  })

  it('clips context at the first line and the recent-tail boundary', () => {
    const earlier = ['error: first', 'one', 'two', 'three', 'four', 'error: last']
    const recent = Array.from({ length: 100 }, (_, index) => `recent ${index}`)

    expect(sliceCheckLogTail([...earlier, ...recent].join('\n'))).toBe(
      [...earlier, PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR, ...recent].join('\n')
    )
  })
})
