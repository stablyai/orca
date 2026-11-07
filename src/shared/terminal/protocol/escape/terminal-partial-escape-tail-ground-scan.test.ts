import { describe, expect, it } from 'vitest'
import { advancePartialEscapeTail, extractPartialEscapeTail } from './terminal-partial-escape-tail'

describe('partial escape scanning between sequences', () => {
  it.each([
    ['\x1b[38;5;', '196m'],
    ['\x1b]2;building', '\x07'],
    ['\x1b]2;building\x1b', '\\', '\x1b'],
    ['\x1bPqpayload', '\x1b\\'],
    ['\x1bPqpayload\x1b', '\\', '\x1b'],
    ['\x1b(', 'B']
  ])(
    'preserves %j through every split after ordinary text',
    (pending, completion, expected = pending) => {
      const prefix = `\x1b[32m${'build output '.repeat(128)}\x1b[0m`
      for (let split = 0; split <= pending.length; split += 1) {
        const first = advancePartialEscapeTail('', prefix + pending.slice(0, split))
        const continued = advancePartialEscapeTail(first, pending.slice(split))
        expect(continued).toBe(expected)
        expect(advancePartialEscapeTail(continued, `${completion}ready`)).toBe('')
      }
    }
  )

  it('handles aborts before returning to ordinary text', () => {
    const text = 'ordinary text '.repeat(128)
    for (const abort of ['\x18', '\x1a']) {
      for (const pending of ['\x1b[38;', '\x1b]2;title', '\x1bPdata', '\x1b(']) {
        expect(extractPartialEscapeTail(`${pending}${abort}${text}\x1b[1;`)).toBe('\x1b[1;')
      }
    }
    expect(extractPartialEscapeTail(`\x1b]2;title\x1b[32m${text}\x1b[1;`)).toBe('\x1b[1;')
  })
})
