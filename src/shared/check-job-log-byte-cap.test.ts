import { afterEach, describe, expect, it, vi } from 'vitest'
import * as byteLimits from './utf8-byte-limits'
import {
  PR_CHECK_LOG_TAIL_BYTES,
  PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR,
  sliceCheckLogTail
} from './check-job-log-tail-slice'

describe('check log excerpt byte-cap work', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['recent', 'earlier'] as const)('bounds byte counting for a long %s line', (position) => {
    const longLine = `error: ${'x'.repeat(2 * 1024 * 1024)}`
    const input = position === 'recent' ? longLine : `${longLine}\n${'recent\n'.repeat(100)}`
    const byteLength = vi.spyOn(byteLimits, 'getUtf8ByteLength')
    const output = sliceCheckLogTail(input)
    const countedUnits = byteLength.mock.calls.reduce((total, [text]) => total + text.length, 0)

    expect(countedUnits).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
    expect(Buffer.byteLength(output)).toBe(PR_CHECK_LOG_TAIL_BYTES)
    if (position === 'recent') {
      expect(output).toBe('x'.repeat(PR_CHECK_LOG_TAIL_BYTES))
    } else {
      expect(output.endsWith(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)).toBe(true)
      expect(output).toContain('\nrecent\n')
    }
  })

  it.each(['x', 'é', '界', '😀', '\ud83d', '\udc00'])(
    'preserves byte boundaries for %j',
    (unit) => {
      const width = Buffer.byteLength(unit)
      for (const delta of [-1, 0, 1]) {
        const count = Math.floor(PR_CHECK_LOG_TAIL_BYTES / width) + delta
        const input = unit.repeat(count)
        const output = sliceCheckLogTail(input)
        expect(output).toBe(
          unit.repeat(Math.min(count, Math.floor(PR_CHECK_LOG_TAIL_BYTES / width)))
        )
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
      }
    }
  )

  it('retains earlier multibyte context whose byte count exceeds its code-unit count', () => {
    const failure = `error: ${'界'.repeat(6000)}`
    const input = `${failure}\n${'recent\n'.repeat(103)}`
    const prefix = `${failure}\nrecent\nrecent\n${PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR}`
    expect(prefix.length).toBeLessThan(PR_CHECK_LOG_TAIL_BYTES)
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(PR_CHECK_LOG_TAIL_BYTES)
    expect(sliceCheckLogTail(input)).toBe(
      byteLimits.clampUtf8TextTail(prefix, PR_CHECK_LOG_TAIL_BYTES).text
    )
  })
})
