import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  prepareBenchmark,
  runDescriptor
} from '../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import { createManifest } from '../../config/scripts/check-job-log-performance-cases.mjs'
import { stripAnsiEscapeSequences } from './ansi-escape-sequences'

describe('ordered linear ANSI stripping', () => {
  it.each([
    ['a\x1b /\x1bc', 'a\x1b /'],
    ['a\x1b /\x00\x1b~b', 'a\x1b /\x00b'],
    ['a\x1b\x1b /0b', 'a\x1bb'],
    ['a\x1b /\x7fb\x1b ', 'a\x1b /\x7fb\x1b ']
  ])('keeps failed generic matches literal before later escapes in %j', (input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
  })
  it.each([
    ['\x1b]a\x1b\\KEEP\x1b]b\x07', 'KEEP'],
    ['\x1bPleft\x07right\x1b\\KEEP', 'KEEP'],
    ['\x1bPleft\x1b]hidden\x1b\\right\x1b\\KEEP', 'KEEP'],
    ['\x1b]body\x1b\x1b\\KEEP', 'KEEP'],
    ['\x1b]body\x1b', 'body\x1b'],
    ['\x1b]a\x07KEEP\x1b]b\x1b\\TAIL', 'KEEPTAIL'],
    ['\x1b]a\x07\x1b\\\x1b]b\x1b\\KEEP', 'KEEP'],
    ['\x1b]a\x9cKEEP\x1bPb\x1b\\TAIL', 'KEEPTAIL'],
    ['\x1b]a\x1b]b\x1bPc', 'abc']
  ])('pins terminator cache edges for %j', (input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
  })
})

// Manual benchmark: opt in with ORCA_CHECK_LOG_PERF=1.
describe.runIf(process.env.ORCA_CHECK_LOG_PERF === '1')(
  'near-cap unfinished 7-bit stripping completion',
  { concurrent: false },
  () => {
    let context: Awaited<ReturnType<typeof prepareBenchmark>>
    beforeAll(async () => {
      context = await prepareBenchmark(process.cwd(), { compareBaseline: false })
    }, 15_000)
    afterAll(async () => {
      await context?.cleanup()
    })
    it.each(['osc', 'dcs'])(
      'completes %s warmups and a sample under the unchanged child watchdog',
      async (family) => {
        const descriptor = createManifest().find(
          (item) =>
            item.mode === 'direct' &&
            item.arm === 'proposed' &&
            item.family === family &&
            item.width === 7 &&
            item.bytes === 63 * 1024 * 1024 &&
            item.sample === 0
        )
        expect(descriptor).toBeDefined()
        const result = await runDescriptor(context, descriptor)
        expect(result.status).toBe('completed')
        expect(result.samples).toHaveLength(1)
      },
      15_000
    )
  }
)
