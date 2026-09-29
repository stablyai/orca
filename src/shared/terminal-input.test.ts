import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INPUT_TOO_LARGE_ERROR,
  assertTerminalInputWithinLimit,
  iterateTerminalInputChunks,
  isTerminalInputTooLarge,
  isTerminalInputTooLargeWithDeferredMeasurement,
  isTerminalInputTooLargeWithYield,
  splitTerminalInputChunks
} from './terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from './clipboard-text'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal input bounds', () => {
  it('splits by UTF-8 bytes without splitting surrogate pairs', () => {
    const chunks = splitTerminalInputChunks('ab😀cd', 4)

    expect(chunks).toEqual(['ab', '😀', 'cd'])
    expect(chunks.join('')).toBe('ab😀cd')
  })

  it('does not scan the full payload before yielding the first chunk', () => {
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const text = 'x'.repeat(128)
    const chunks = iterateTerminalInputChunks(text, 8)

    expect(chunks.next()).toEqual({ done: false, value: 'x'.repeat(8) })

    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)
  })

  it('keeps a single multibyte terminal character intact when the byte cap is smaller', () => {
    const chunks = splitTerminalInputChunks('😀a', 1)

    expect(chunks).toEqual(['😀', 'a'])
    expect(chunks.join('')).toBe('😀a')
  })

  it('rejects oversized terminal input with a metadata-only error', () => {
    const secret = 'terminal-secret-token'
    const payload = [secret, 'payload'].join('')

    expect(() => assertTerminalInputWithinLimit(payload, 4)).toThrow(TERMINAL_INPUT_TOO_LARGE_ERROR)
    expect(() => assertTerminalInputWithinLimit(payload, 4)).not.toThrow(secret)
  })

  it('rejects multibyte oversized terminal input at the byte boundary', () => {
    expect(isTerminalInputTooLarge('😀'.repeat(3), 5)).toBe(true)
    expect(() => assertTerminalInputWithinLimit('😀'.repeat(3), 5)).toThrow(
      TERMINAL_INPUT_TOO_LARGE_ERROR
    )
  })

  it('rejects terminal input whose string length already exceeds the byte limit without scanning', () => {
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')

    expect(isTerminalInputTooLarge('x'.repeat(6), 5)).toBe(true)
    expect(() => assertTerminalInputWithinLimit('x'.repeat(6), 5)).toThrow(
      TERMINAL_INPUT_TOO_LARGE_ERROR
    )
    expect(codePointAt).not.toHaveBeenCalled()
  })

  it('yields while measuring accepted large terminal input', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
    const result = isTerminalInputTooLargeWithYield(text, text.length * 3)
    let settled = false
    void result.then(() => {
      settled = true
    })

    await Promise.resolve()

    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(0)

    await expect(result).resolves.toBe(false)
  })

  it('returns a pending validation for accepted large terminal input', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
    const result = isTerminalInputTooLargeWithDeferredMeasurement(text, text.length * 3)
    let settled = false
    void Promise.resolve(result).then(() => {
      settled = true
    })

    await Promise.resolve()

    expect(result).toBeInstanceOf(Promise)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(0)

    await expect(result).resolves.toBe(false)
  })
})
