import { describe, expect, it } from 'vitest'
import {
  isSafeTimerDelayMs,
  MAX_TIMER_DELAY_MS,
  parsePositiveSafeIntegerNumericText,
  parsePositiveSafeIntegerText
} from './timer-delay'

describe('timer delay policy', () => {
  it.each([0, 1, MAX_TIMER_DELAY_MS])('accepts timer delay %s', (value) => {
    expect(isSafeTimerDelayMs(value)).toBe(true)
  })

  it.each([-1, 1.5, MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects timer delay %s',
    (value) => {
      expect(isSafeTimerDelayMs(value)).toBe(false)
    }
  )

  it.each([
    ['1', 1],
    ['00123', 123],
    ['+1000', 1_000],
    ['1000.0', 1_000],
    ['1e3', 1_000],
    ['.1e4', 1_000],
    ['0x3e8', 1_000],
    ['0b1000', 8],
    ['0o10', 8],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]
  ])('parses exact positive safe integer text %s', (raw, expected) => {
    expect(parsePositiveSafeIntegerText(raw)).toBe(expected)
  })

  it.each(['', '0', '-1', '1.5', '.1', '1e-1', '9007199254740991.1', '9007199254740992'])(
    'rejects inexact or unsafe integer text %s',
    (raw) => {
      expect(parsePositiveSafeIntegerText(raw)).toBeNull()
    }
  )

  it.each([
    ['+1000', 1_000],
    ['1000.0', 1_000],
    ['1e3', 1_000]
  ])('parses CLI-compatible positive integer text %s', (raw, expected) => {
    expect(parsePositiveSafeIntegerNumericText(raw)).toBe(expected)
  })

  it.each(['', '0', '-1', '1.5', 'Infinity', '9007199254740992'])(
    'rejects invalid CLI-compatible integer text %s',
    (raw) => {
      expect(parsePositiveSafeIntegerNumericText(raw)).toBeNull()
    }
  )
})
