import { describe, expect, it, vi } from 'vitest'
import { advancePartialEscapeTail, extractPartialEscapeTail } from './terminal-partial-escape-tail'

describe('partial escape scanning between sequences', () => {
  it.each([
    ['ASCII', 'ordinary output '.repeat(8192)],
    ['UTF-16', '漢字😀 output '.repeat(8192)]
  ])('skips ordinary %s text between completed escapes', (_name, text) => {
    const pending = '\x1b[38;5;'
    const stream = `\x1b[32m${text}\x1b[0m${text}${pending}`
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    let actual: string
    let inspectedCodeUnits: number
    try {
      actual = extractPartialEscapeTail(stream)
      inspectedCodeUnits = charCodeAt.mock.calls.length
    } finally {
      charCodeAt.mockRestore()
    }

    expect(actual).toBe(pending)
    expect(inspectedCodeUnits).toBeLessThan(32)
    expect(advancePartialEscapeTail(actual, '196mready')).toBe('')
  })

  it.each([
    ['\x1b[38;5;', '196m'],
    ['\x1b]2;building', '\x07'],
    ['\x1b]2;building\x1b', '\\'],
    ['\x1bPqpayload', '\x1b\\'],
    ['\x1bPqpayload\x1b', '\\'],
    ['\x1b(', 'B']
  ])('preserves %j through every split after ordinary text', (pending, completion) => {
    const prefix = `\x1b[32m${'build output '.repeat(128)}\x1b[0m`
    for (let split = 0; split <= pending.length; split += 1) {
      const first = advancePartialEscapeTail('', prefix + pending.slice(0, split))
      const continued = advancePartialEscapeTail(first, pending.slice(split))
      expect(continued).toBe(pending)
      expect(advancePartialEscapeTail(continued, `${completion}ready`)).toBe('')
    }
  })

  it('handles aborts before returning to ordinary text', () => {
    const text = 'ordinary text '.repeat(128)
    for (const abort of ['\x18', '\x1a']) {
      for (const pending of ['\x1b[38;', '\x1b]2;title', '\x1bPdata', '\x1b(']) {
        expect(extractPartialEscapeTail(`${pending}${abort}${text}\x1b[1;`)).toBe('\x1b[1;')
      }
    }
    expect(extractPartialEscapeTail(`\x1b]2;title\x1b[32m${text}\x1b[1;`)).toBe('\x1b[1;')
  })

  it('keeps one-character echo free of per-code-unit scans and escape searches', () => {
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    let actual: string
    let inspections: number
    let searches: number
    try {
      actual = advancePartialEscapeTail('', 'x')
      inspections = charCodeAt.mock.calls.length
      searches = indexOf.mock.calls.length
    } finally {
      charCodeAt.mockRestore()
      indexOf.mockRestore()
    }

    expect(actual).toBe('')
    expect(inspections).toBe(0)
    expect(searches).toBe(0)
  })
})
