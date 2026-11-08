import { describe, expect, it } from 'vitest'
import { SearchSubprocessLineAccumulator } from './search-subprocess-lines'

describe('SearchSubprocessLineAccumulator', () => {
  it('still enforces per-line UTF-8 byte limits for decoded batches', () => {
    const parser = new SearchSubprocessLineAccumulator(4)
    const lines: string[] = []
    expect(parser.push('éé\n漢\n', (line) => lines.push(line))).toBe(true)
    expect(parser.push('漢é\n', (line) => lines.push(line))).toBe(false)
    expect(lines).toEqual(['éé', '漢'])
    expect(parser.finish()).toBeNull()
  })

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

  it('rejects invalid byte limits', () => {
    expect(() => new SearchSubprocessLineAccumulator(-1)).toThrow(RangeError)
  })
})

describe('oversized search record continuation', () => {
  it.each(['clear', 'finish'] as const)('resets an unterminated discard on %s', (reset) => {
    const parser = new SearchSubprocessLineAccumulator(4, 'discard')
    const lines: string[] = []
    expect(parser.push('oversized', (line) => lines.push(line))).toBe(false)
    parser[reset]()
    expect(parser.push('four\n', (line) => lines.push(line))).toBe(true)
    expect(lines).toEqual(['four'])
  })
})
