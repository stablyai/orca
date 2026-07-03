import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_TOO_LARGE_ERROR,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR,
  assertClipboardTextWriteWithinLimit,
  assertClipboardTextWriteWithinLimitWithYield,
  assertClipboardTextWithinLimit,
  assertClipboardTextWithinLimitWithYield,
  getClipboardTextByteLength,
  isClipboardTextByteLengthOverLimit,
  isClipboardTextByteLengthOverLimitWithYield,
  isClipboardTextTooLargeError,
  isClipboardTextWriteTooLargeError,
  measureClipboardTextByteLength,
  measureClipboardTextByteLengthWithYield
} from './clipboard-text'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('clipboard text limits', () => {
  it('measures UTF-8 bytes instead of UTF-16 code units', () => {
    expect(getClipboardTextByteLength('a😀')).toBe(5)
  })

  it('can stop measuring once a byte limit is exceeded', () => {
    const measurement = measureClipboardTextByteLength('😀'.repeat(100), {
      stopAfterBytes: 5
    })

    expect(measurement).toEqual({ byteLength: 8, exceededLimit: true })
    expect(measurement.byteLength).toBeLessThan(getClipboardTextByteLength('😀'.repeat(100)))
  })

  it('detects text over a byte limit without requiring full measurement', () => {
    expect(isClipboardTextByteLengthOverLimit('😀'.repeat(100), 5)).toBe(true)
    expect(isClipboardTextByteLengthOverLimit('éé', 4)).toBe(false)
  })

  it('yields while measuring large accepted clipboard text', async () => {
    const yieldToEventLoop = vi.fn(async () => {})

    const measurement = await measureClipboardTextByteLengthWithYield('x'.repeat(32), {
      stopAfterBytes: 64,
      yieldAfterCodeUnits: 8,
      yieldToEventLoop
    })

    expect(measurement).toEqual({ byteLength: 32, exceededLimit: false })
    expect(yieldToEventLoop).toHaveBeenCalled()
  })

  it('uses the default 256k code-unit yield cadence for accepted large clipboard text', async () => {
    const yieldToEventLoop = vi.fn(async () => {})

    const measurement = await measureClipboardTextByteLengthWithYield(
      'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS * 2 + 1),
      {
        yieldToEventLoop
      }
    )

    expect(measurement.exceededLimit).toBe(false)
    expect(yieldToEventLoop).toHaveBeenCalledTimes(2)
  })

  it('yields while checking multibyte clipboard limits before rejecting', async () => {
    const yieldToEventLoop = vi.fn(async () => {})

    await expect(
      isClipboardTextByteLengthOverLimitWithYield('é'.repeat(16), 31, {
        yieldAfterCodeUnits: 4,
        yieldToEventLoop
      })
    ).resolves.toBe(true)

    expect(yieldToEventLoop).toHaveBeenCalled()
  })

  it('rejects text whose string length already exceeds the byte limit without scanning', () => {
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')

    expect(isClipboardTextByteLengthOverLimit('x'.repeat(6), 5)).toBe(true)
    expect(() => assertClipboardTextWithinLimit('x'.repeat(6), { maxBytes: 5 })).toThrow(
      CLIPBOARD_TEXT_TOO_LARGE_ERROR
    )
    expect(() => assertClipboardTextWriteWithinLimit('x'.repeat(6), { maxBytes: 5 })).toThrow(
      CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
    )
    expect(codePointAt).not.toHaveBeenCalled()
  })

  it('lets each clipboard consumer override the shared default byte limits', async () => {
    expect(assertClipboardTextWithinLimit('abc', { maxBytes: 3 })).toBe('abc')
    expect(() => assertClipboardTextWithinLimit('abc', { maxBytes: 2 })).toThrow(
      CLIPBOARD_TEXT_TOO_LARGE_ERROR
    )
    expect(assertClipboardTextWriteWithinLimit('copy', { maxBytes: 4 })).toBe('copy')
    expect(() => assertClipboardTextWriteWithinLimit('copy', { maxBytes: 3 })).toThrow(
      CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
    )

    await expect(assertClipboardTextWithinLimitWithYield('async', { maxBytes: 5 })).resolves.toBe(
      'async'
    )
    await expect(
      assertClipboardTextWriteWithinLimitWithYield('async', { maxBytes: 4 })
    ).rejects.toThrow(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)
  })

  it('rejects oversized text with a metadata-only error', () => {
    expect(() => assertClipboardTextWithinLimit('secret-token-value', { maxBytes: 4 })).toThrow(
      CLIPBOARD_TEXT_TOO_LARGE_ERROR
    )

    try {
      assertClipboardTextWithinLimit('secret-token-value', { maxBytes: 4 })
    } catch (error) {
      expect(isClipboardTextTooLargeError(error)).toBe(true)
      expect(String(error)).not.toContain('secret-token-value')
    }
  })

  it('rejects oversized async clipboard reads and writes with metadata-only errors', async () => {
    await expect(
      assertClipboardTextWithinLimitWithYield('secret-token-value', { maxBytes: 4 })
    ).rejects.toThrow(CLIPBOARD_TEXT_TOO_LARGE_ERROR)
    await expect(
      assertClipboardTextWriteWithinLimitWithYield('copied-secret-token-value', { maxBytes: 4 })
    ).rejects.toThrow(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)

    try {
      await assertClipboardTextWithinLimitWithYield('secret-token-value', { maxBytes: 4 })
    } catch (error) {
      expect(isClipboardTextTooLargeError(error)).toBe(true)
      expect(String(error)).not.toContain('secret-token-value')
    }
  })

  it('rejects oversized clipboard writes with a metadata-only error', () => {
    expect(() =>
      assertClipboardTextWriteWithinLimit('copied-secret-token-value', { maxBytes: 4 })
    ).toThrow(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)

    try {
      assertClipboardTextWriteWithinLimit('copied-secret-token-value', { maxBytes: 4 })
    } catch (error) {
      expect(isClipboardTextWriteTooLargeError(error)).toBe(true)
      expect(isClipboardTextTooLargeError(error)).toBe(false)
      expect(String(error)).not.toContain('copied-secret-token-value')
    }
  })
})
