import { describe, expect, it } from 'vitest'
import {
  boundRawCheckLogTail,
  MAX_RAW_CHECK_LOG_CHARS,
  toReadableCheckLogExcerpt
} from './check-job-log-excerpt'
import {
  PR_CHECK_LOG_TAIL_BYTES,
  PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR
} from './check-job-log-tail-slice'

const ESC = '\u001b'
const RED = `${ESC}[31m`
const RESET = `${ESC}[0m`

describe('toReadableCheckLogExcerpt', () => {
  it('returns an empty excerpt for an empty log', () => {
    expect(toReadableCheckLogExcerpt('')).toBe('')
  })

  it('strips ANSI colour sequences a workflow printed', () => {
    const excerpt = toReadableCheckLogExcerpt(`${RED}##[error]Process exited with code 1${RESET}`)

    expect(excerpt).toBe('##[error]Process exited with code 1')
    expect(excerpt).not.toContain(ESC)
  })

  it('strips escapes from every line, not just the first', () => {
    const coloured = Array.from(
      { length: 400 },
      (_, index) => `${RED}step ${index} still running${RESET}`
    ).join('\n')

    const excerpt = toReadableCheckLogExcerpt(coloured)

    expect(excerpt).not.toContain(ESC)
    expect(excerpt.split('\n').at(-1)).toBe('step 399 still running')
  })

  it('breaks carriage-return progress into lines instead of one clamped blob', () => {
    const progress = Array.from({ length: 5_000 }, (_, index) => `downloading ${index}%`).join('\r')

    const excerpt = toReadableCheckLogExcerpt(`${progress}\n##[error]Process exited with code 1`)

    expect(excerpt).toContain('##[error]Process exited with code 1')
    // Without CR normalisation the redraws stay one line, and the byte cap then
    // spends the whole excerpt budget on a single unreadable progress fragment.
    expect(excerpt.split('\n').length).toBeGreaterThan(100)
    expect(Buffer.from(excerpt, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('keeps the earlier-error window working through the excerpt', () => {
    const lines = [
      '##[error]the real failure',
      ...Array.from({ length: 500 }, (_, index) => `noise line ${index}`)
    ]

    const excerpt = toReadableCheckLogExcerpt(lines.join('\n'))

    expect(excerpt).toContain('##[error]the real failure')
    expect(excerpt).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
  })

  it('bounds a multi-megabyte log before slicing it', () => {
    const filler = 'x'.repeat(MAX_RAW_CHECK_LOG_CHARS * 2)

    const excerpt = toReadableCheckLogExcerpt(`${filler}\n##[error]Process exited with code 1`)

    expect(excerpt).toContain('##[error]Process exited with code 1')
    expect(Buffer.from(excerpt, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })
})

describe('boundRawCheckLogTail', () => {
  it('passes a log within the bound through untouched', () => {
    expect(boundRawCheckLogTail('short log')).toBe('short log')
  })

  it('drops the partial first line so a halved escape cannot survive', () => {
    const head = `${'a'.repeat(MAX_RAW_CHECK_LOG_CHARS)}\n`

    const bounded = boundRawCheckLogTail(`${head}kept line`)

    expect(bounded).toBe('kept line')
  })

  it('keeps the tail when the bounded slice has no line break', () => {
    const bounded = boundRawCheckLogTail('b'.repeat(MAX_RAW_CHECK_LOG_CHARS + 10))

    expect(bounded).toHaveLength(MAX_RAW_CHECK_LOG_CHARS)
  })
})
