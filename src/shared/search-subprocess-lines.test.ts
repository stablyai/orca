import { describe, expect, it, vi } from 'vitest'
import { SearchSubprocessLineAccumulator } from './search-subprocess-lines'

describe('SearchSubprocessLineAccumulator', () => {
  it('emits decoded batches without re-encoding them with Buffer.from', () => {
    const parser = new SearchSubprocessLineAccumulator()
    const lines: string[] = []
    const from = vi.spyOn(Buffer, 'from')
    let copies: number
    try {
      parser.push('first🐋\n\nlast\n', (line) => lines.push(line))
      copies = from.mock.calls.length
    } finally {
      from.mockRestore()
    }
    expect(copies).toBe(0)
    expect(lines).toEqual(['first🐋', '', 'last'])
    expect(parser.finish()).toBeNull()
  })

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

  it('retains a fragmented line until finish and releases its capacity', () => {
    const parser = new SearchSubprocessLineAccumulator(256 * 1024)
    const byte = Buffer.from('x')
    let accepted = true

    for (let index = 0; index < 200_000; index += 1) {
      accepted = parser.push(byte, () => {}) && accepted
    }

    expect(accepted).toBe(true)
    expect(parser.retainedCapacityBytes()).toBeGreaterThanOrEqual(200_000)
    expect(parser.finish()).toBe('x'.repeat(200_000))
    expect(parser.retainedCapacityBytes()).toBeNull()
  })

  it('rejects invalid byte limits', () => {
    expect(() => new SearchSubprocessLineAccumulator(-1)).toThrow(RangeError)
  })
})

describe('oversized search record continuation', () => {
  it.each(['string', 'buffer'])('keeps complete lines around an oversized %s record', (kind) => {
    const parser = new SearchSubprocessLineAccumulator(4, 'discard')
    const lines: string[] = []
    const batch = 'four\noversized\nnext\n'
    expect(
      parser.push(kind === 'buffer' ? Buffer.from(batch) : batch, (line) => lines.push(line))
    ).toBe(false)
    expect(lines).toEqual(['four', 'next'])
    expect(parser.retainedCapacityBytes()).toBeNull()
    expect(parser.finish()).toBeNull()
  })

  it('discards a fragmented record through its newline before accepting UTF-8 again', () => {
    const parser = new SearchSubprocessLineAccumulator(4, 'discard')
    const lines: string[] = []
    expect(parser.push(Buffer.from('ab'), (line) => lines.push(line))).toBe(true)
    expect(parser.push(Buffer.from('cde'), (line) => lines.push(line))).toBe(false)
    expect(parser.retainedCapacityBytes()).toBeNull()
    expect(parser.push('suffix', (line) => lines.push(line))).toBe(true)
    expect(parser.push('\néé\n', (line) => lines.push(line))).toBe(true)
    expect(lines).toEqual(['éé'])
    expect(parser.finish()).toBeNull()
  })

  it.each(['clear', 'finish'] as const)('resets an unterminated discard on %s', (reset) => {
    const parser = new SearchSubprocessLineAccumulator(4, 'discard')
    const lines: string[] = []
    expect(parser.push('oversized', (line) => lines.push(line))).toBe(false)
    parser[reset]()
    expect(parser.push('four\n', (line) => lines.push(line))).toBe(true)
    expect(lines).toEqual(['four'])
  })

  it('skips adjacent oversized records without changing the byte limit for later records', () => {
    const parser = new SearchSubprocessLineAccumulator(4, 'discard')
    const lines: string[] = []
    expect(parser.push('five5\nsixsix\n漢é\nfour\n', (line) => lines.push(line))).toBe(false)
    expect(lines).toEqual(['four'])
    expect(parser.retainedCapacityBytes()).toBeNull()
  })
})
