import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ansi from './ansi-escape-sequences'
import * as byteLimits from './utf8-byte-limits'
import { createCheckLogFixture } from '../../config/scripts/check-job-log-test-fixture.mjs'
import {
  PR_CHECK_LOG_TAIL_BYTES,
  PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR,
  sliceCheckLogTail
} from './check-job-log-tail-slice'

const trailing = Array.from({ length: 210 }, (_, index) => `recent ${index}`).join('\n')
const fixture = createCheckLogFixture()
const earlier = (line: string): string => `${line}\n${trailing}`

describe('bounded ANSI-aware marker candidates', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each([
    '##[error]',
    '::error::',
    '::error',
    'error:',
    'FAILED',
    'exit code',
    'ENOENT',
    'EACCES',
    'panic:',
    'AssertionError'
  ])('recognizes interrupted and surrounded %s before recent lines', (marker) => {
    for (const color of ['\x1b[31m', '\x9b31m']) {
      const line = `unique ${color}${marker.slice(0, 3)}${color}${marker.slice(3)}\x1b[0m`
      expect(sliceCheckLogTail(earlier(line))).toContain(`unique ${marker}`)
      expect(sliceCheckLogTail(earlier(line))).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
    }
  })
  it.each(['\x1b]', '\x9d', '\x1bP', '\x90', '\x1b_', '\x9f', '\x1b^', '\x9e', '\x1bX', '\x98'])(
    'ignores invisible markers in complete %j payloads',
    (intro) => {
      const input = earlier(`hidden ${intro}error: invisible\x1b\\ suffix`)
      expect(sliceCheckLogTail(input)).not.toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
    }
  )
  it.each([
    ['er', 'ror:'],
    ['::er', 'ror::'],
    ['er\x1b', '[31mror:'],
    ['::er\x1b[31m', 'ror::']
  ])('does not join independent %j/%j windows', (left, right) => {
    const window = PR_CHECK_LOG_TAIL_BYTES / 2
    const line = `${'x'.repeat(window - left.length)}${left}${'m'.repeat(20000)}${right}${'x'.repeat(window - right.length)}`
    expect(sliceCheckLogTail(earlier(line))).not.toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
  })
  it.each(['prefix', 'tail', 'middle'] as const)(
    'limits oversized %s markers to independent edges',
    (position) => {
      const marker = 'error: EDGE'
      const line =
        position === 'prefix'
          ? `${marker}${'x'.repeat(40000)}`
          : position === 'tail'
            ? `${'x'.repeat(40000)} ${marker}`
            : `${'x'.repeat(20000)} ${marker}${'x'.repeat(20000)}`
      expect(sliceCheckLogTail(earlier(line)).includes(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)).toBe(
        position !== 'middle'
      )
    }
  )
  it.each(['x', '界', '😀', '\ud800', '\udfff'])(
    'bounds actual normalization and marker inputs for %j',
    (unit) => {
      const input = earlier(`error: ${unit.repeat(20000)}`)
      const strip = vi.spyOn(ansi, 'stripAnsiEscapeSequences')
      const count = vi.spyOn(byteLimits, 'getUtf8ByteLength')
      const fit = vi.spyOn(byteLimits, 'isUtf8ByteLengthWithinLimit')
      const test = RegExp.prototype.test
      const matcherBytes: number[] = []
      const pattern = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (
        this: RegExp,
        value: string
      ) {
        if (this.source.includes('AssertionError')) {
          matcherBytes.push(byteLimits.measureUtf8ByteLength(value).byteLength)
        }
        return test.call(this, value)
      })
      try {
        const output = sliceCheckLogTail(input)
        const normalized = strip.mock.calls.map(
          ([value]) => byteLimits.measureUtf8ByteLength(value).byteLength
        )
        expect(Math.max(...normalized)).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
        expect(normalized.slice(0, -1).every((bytes) => bytes <= PR_CHECK_LOG_TAIL_BYTES / 2)).toBe(
          true
        )
        expect(Math.max(...matcherBytes)).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES / 2)
        expect(count.mock.calls.every(([value]) => value.length <= PR_CHECK_LOG_TAIL_BYTES)).toBe(
          true
        )
        expect(fit.mock.calls.every(([, limit]) => limit === PR_CHECK_LOG_TAIL_BYTES)).toBe(true)
        expect(byteLimits.measureUtf8ByteLength(output).byteLength).toBeLessThanOrEqual(
          PR_CHECK_LOG_TAIL_BYTES
        )
      } finally {
        strip.mockClear()
        count.mockClear()
        fit.mockClear()
        pattern.mockRestore()
      }
    }
  )
  it('preserves failure context in recent and generated earlier modes', () => {
    const recent = sliceCheckLogTail(fixture.rawLog)
    expect(recent).toContain(fixture.expectedDiagnostic)
    expect(recent).toContain(fixture.expectedStackFrame)
    const rawRows = fixture.rawLog.split('\n')
    const diagnostic =
      rawRows.find((line) =>
        ansi.stripAnsiEscapeSequences(line).includes(fixture.expectedDiagnostic)
      ) ?? ''
    const frame = rawRows.find((line) => line.includes(fixture.expectedStackFrame)) ?? ''
    const output = sliceCheckLogTail(`${diagnostic}\n${frame}\n${trailing}`)
    expect(output).toContain(fixture.expectedDiagnostic)
    expect(output).toContain(fixture.expectedStackFrame)
    expect(output).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
  })
  it.each(['\n', '\r\n', '\r'])(
    'splits raw %j while preserving selection and trailing empty entry',
    (separator) => {
      const rows = [
        'first',
        'error: retained',
        '',
        ...Array.from({ length: 210 }, (_, i) => `row ${i}`),
        ''
      ]
      expect(sliceCheckLogTail(rows.join(separator))).toBe(sliceCheckLogTail(rows.join('\n')))
      expect(sliceCheckLogTail(`a${separator}${separator}b${separator}`)).toBe('a\n\nb\n')
    }
  )
  it('handles mixed CR/CRLF/LF without merging lines', () => {
    expect(sliceCheckLogTail('a\rb\r\nc\n\r\nd\r')).toBe('a\nb\nc\n\nd\n')
  })
})
