import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCheckLogFixture } from '../../config/scripts/check-job-log-test-fixture.mjs'
import { PR_CHECK_LOG_TAIL_BYTES, sanitizeCheckJobLogExcerpt } from './check-job-log-excerpt'
import * as ansi from './ansi-escape-sequences'
import * as ownership from './own-retained-string'
import * as bytes from './utf8-byte-limits'

const limit = PR_CHECK_LOG_TAIL_BYTES
const fixture = createCheckLogFixture()

describe('bounded owned check log sanitation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    ownership.resetOwnRetainedStringCopier()
  })
  it('normalizes separators and unsafe controls while preserving layout', () => {
    const raw = '  α\t\x1b[31merror:\x1b[0m\r\n界\r😀\n\x00\x01\x08\x0b\x0c\x1f\x7f\x85\x9c\n'
    expect(sanitizeCheckJobLogExcerpt(raw)).toBe('  α\terror:\n界\n😀\n\n')
  })
  it('removes a provider log BOM while preserving diagnostics and layout', () => {
    const raw = '\ufefferror: build failed\r\n  at α.ts:1\t界😀\n'
    expect(sanitizeCheckJobLogExcerpt(raw)).toBe('error: build failed\n  at α.ts:1\t界😀\n')
  })
  it('preserves emoji and word joiners while removing other format controls', () => {
    const raw = '\ufeff👨\u200d👩\u200d👧\u200d👦 می\u200cروم \u202eerror\u202c\u200b\n'
    expect(sanitizeCheckJobLogExcerpt(raw)).toBe('👨\u200d👩\u200d👧\u200d👦 می\u200cروم error\n')
  })
  it.each(['x', 'é', '界', '😀', '\ud800', '\udfff'])('caps UTF-8 %j at byte edges', (unit) => {
    const width = bytes.getUtf8ByteLength(unit)
    for (const delta of [-1, 0, 1]) {
      const input = unit.repeat(Math.floor(limit / width) + delta)
      const result = sanitizeCheckJobLogExcerpt(input)
      expect(result).toBe(
        unit.repeat(Math.min(Math.floor(limit / width), input.length / unit.length))
      )
      expect(bytes.getUtf8ByteLength(result)).toBeLessThanOrEqual(limit)
      expect(sanitizeCheckJobLogExcerpt(result)).toBe(result)
    }
  })
  it('bounds raw text before ANSI, counting or copying, with no refill', () => {
    const strip = vi.spyOn(ansi, 'stripAnsiEscapeSequences')
    const count = vi.spyOn(bytes, 'getUtf8ByteLength')
    const own = vi.spyOn(ownership, 'ownRetainedString')
    const input = `${'omitted'.repeat(limit)}${'\x1b[31m'.repeat(4000)}LAST`
    const result = sanitizeCheckJobLogExcerpt(input)
    expect(result).toBe('LAST')
    expect(strip).toHaveBeenCalledTimes(1)
    expect(
      strip.mock.calls.every(([value]) => bytes.measureUtf8ByteLength(value).byteLength <= limit)
    ).toBe(true)
    expect(count).not.toHaveBeenCalled()
    expect(own).toHaveBeenLastCalledWith('LAST')
    strip.mockClear()
    own.mockClear()
  })
  it.each(['x', 'é', '界', '😀', '\ud800', '\udfff'])(
    'preserves precise byte edges for %j',
    (unit) => {
      const width = bytes.getUtf8ByteLength(unit)
      for (const delta of [-1, 0, 1]) {
        const count = Math.floor((limit + delta) / width)
        const padding = 'x'.repeat((limit + delta) % width)
        const input = unit.repeat(count) + padding
        expect(bytes.getUtf8ByteLength(input)).toBe(limit + delta)
        expect(sanitizeCheckJobLogExcerpt(input)).toBe(
          unit.repeat(count - (delta > 0 ? 1 : 0)) + padding
        )
      }
    }
  )
  it.each([
    ['\x1b[31m', '[31m'],
    ['\x1b]body', ']body'],
    ['\x1bPbody', 'Pbody'],
    ['\x1b_body', '_body'],
    ['\x1b^body', '^body'],
    ['\x1bXbody', 'Xbody']
  ])('uses fresh state when the raw tail cuts an introducer %j', (sequence, fragment) => {
    const retained = fragment + 'x'.repeat(limit - fragment.length)
    expect(
      sanitizeCheckJobLogExcerpt(
        `${'omitted'.repeat(limit)}${sequence}${'x'.repeat(limit - fragment.length)}`
      )
    ).toBe(retained)
  })
  it('always owns an unchanged plain excerpt', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    const input = '  plain unchanged\ttext\n'
    expect(sanitizeCheckJobLogExcerpt(input)).toBe(input)
    expect(own).toHaveBeenCalledTimes(1)
    expect(own).toHaveBeenLastCalledWith(input)
  })
  it('owns without Buffer and preserves source lone surrogates', () => {
    vi.stubGlobal('Buffer', undefined)
    ownership.resetOwnRetainedStringCopier()
    try {
      expect(sanitizeCheckJobLogExcerpt(`${'x'.repeat(20000)}\ud800a\udfff\n`)).toBe(
        `${'x'.repeat(limit - 8)}\ud800a\udfff\n`
      )
    } finally {
      vi.unstubAllGlobals()
      ownership.resetOwnRetainedStringCopier()
    }
  })
  it.each([
    ['\x1b', ''],
    ['\x1b[31', '31'],
    ['\x9b31', '31'],
    ['\x1b]body\x1b', 'body'],
    ['\x9dbody', 'body'],
    ['\x1bPbody\x1b', 'body'],
    ['\x90body', 'body'],
    ['payload\x1b\\TAIL', 'payloadTAIL'],
    ['payload\x9cTAIL', 'payloadTAIL']
  ])('keeps literal fragments at a cut %j', (suffix, expected) => {
    expect(sanitizeCheckJobLogExcerpt(suffix)).toBe(expected)
    expect(sanitizeCheckJobLogExcerpt(`${'z'.repeat(2 * limit)}${suffix}`)).toBe(
      `${'z'.repeat(limit - bytes.getUtf8ByteLength(suffix))}${expected}`
    )
  })
  it('keeps failure diagnostic and nearby stack', () => {
    const result = sanitizeCheckJobLogExcerpt(fixture.rawLog)
    expect(result).toContain(fixture.expectedDiagnostic)
    expect(result).toContain(fixture.expectedStackFrame)
    expect(result).toContain(fixture.benignMarker)
    expect(result).toContain(fixture.genericExitMarker)
    expect(ansi.TERMINAL_CONTROL_CHARACTER_PATTERN.test(result)).toBe(false)
    expect(sanitizeCheckJobLogExcerpt(result)).toBe(result)
  })
})
