import { describe, expect, it } from 'vitest'
import { SearchSubprocessLineAccumulator } from './search-subprocess-lines'

describe('SearchSubprocessLineAccumulator', () => {
  it('preserves UTF-8 records split across raw byte chunks', () => {
    const parser = new SearchSubprocessLineAccumulator(32)
    const bytes = Buffer.from('first🐋\nsecond')
    const lines: string[] = []

    expect(parser.push(bytes.subarray(0, 7), (line) => lines.push(line))).toBe(true)
    expect(parser.push(bytes.subarray(7), (line) => lines.push(line))).toBe(true)

    expect(lines).toEqual(['first🐋'])
    expect(parser.finish()).toBe('second')
  })

  it('accepts an exact byte limit and rejects the next byte without decoding it', () => {
    const parser = new SearchSubprocessLineAccumulator(4)
    const lines: string[] = []

    expect(parser.push(Buffer.from('four\n'), (line) => lines.push(line))).toBe(true)
    expect(parser.push(Buffer.from('fives'), (line) => lines.push(line))).toBe(false)

    expect(lines).toEqual(['four'])
    expect(parser.finish()).toBeNull()
  })

  it('preserves empty lines and line order within one chunk', () => {
    const parser = new SearchSubprocessLineAccumulator(8)
    const lines: string[] = []

    expect(parser.push(Buffer.from('\na\n\n'), (line) => lines.push(line))).toBe(true)

    expect(lines).toEqual(['', 'a', ''])
  })

  it('retains one growable buffer for adversarial one-byte fragments', () => {
    const parser = new SearchSubprocessLineAccumulator(256 * 1024)
    const byte = Buffer.from('x')
    let accepted = true

    for (let index = 0; index < 200_000; index += 1) {
      accepted = parser.push(byte, () => {}) && accepted
    }

    expect(accepted).toBe(true)
    expect(Reflect.get(parser, 'buffer')).toBeInstanceOf(Buffer)
    expect(parser.finish()).toBe('x'.repeat(200_000))
    expect(Reflect.get(parser, 'buffer')).toBeNull()
  })

  it('rejects invalid byte limits', () => {
    expect(() => new SearchSubprocessLineAccumulator(-1)).toThrow(RangeError)
  })
})
