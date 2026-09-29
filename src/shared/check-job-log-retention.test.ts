import { describe, expect, it } from 'vitest'
import { PR_CHECK_LOG_TAIL_BYTES, sliceCheckLogTail } from './check-job-log-tail-slice'
import { gitLabJobTraceToLogExcerpt } from './gitlab-job-log-excerpt'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

const PARENT_CHARS = 2 * 1024 * 1024
const COUNT = 8

describe('retained CI log excerpts', () => {
  it.each([
    [
      'GitHub long line',
      (index: number) => `${index}:${'x'.repeat(PARENT_CHARS)}`,
      sliceCheckLogTail
    ],
    [
      'GitHub earlier error',
      (index: number) => `error: ${index}:${'界'.repeat(PARENT_CHARS)}\n${'recent\n'.repeat(100)}`,
      sliceCheckLogTail
    ],
    [
      'GitLab raw trace',
      (index: number) => `${index}:${'x'.repeat(PARENT_CHARS)}`,
      gitLabJobTraceToLogExcerpt
    ]
  ] as const)('releases the parent of a %s', (_label, makeLog, excerpt) => {
    const before = heapAfterGc()
    const retained = Array.from({ length: COUNT }, (_value, index) => excerpt(makeLog(index)))
    // V8's legacy RegExp statics can otherwise keep the final input independently of our cache.
    void /probe/.test('probe')
    const growth = heapAfterGc() - before

    expect(retained).toHaveLength(COUNT)
    expect(retained.every((text) => Buffer.byteLength(text) <= PR_CHECK_LOG_TAIL_BYTES)).toBe(true)
    expect(growth).toBeLessThan(PARENT_CHARS * 2)
  })
})
