import { describe, expect, it } from 'vitest'
import { GrowingByteBuffer } from './growing-byte-buffer'

describe('GrowingByteBuffer', () => {
  it('copies live bytes without consuming them or exposing mutable storage', () => {
    const buffer = new GrowingByteBuffer()
    buffer.append(Buffer.from('prefix-tail'))
    buffer.retainSuffix(4)
    const snapshot = buffer.toBuffer()
    snapshot.fill(0)
    expect(buffer.toBuffer()).toEqual(Buffer.from('tail'))
    expect(buffer.byteLength).toBe(4)
    const retained = buffer.toBuffer()
    buffer.appendRetainedSuffix(Buffer.from('next'), 4)
    expect(retained).toEqual(Buffer.from('tail'))
    expect(buffer.toBuffer()).toEqual(Buffer.from('next'))
  })

  it('transfers binary bytes without changing them on clear or reuse', () => {
    const buffer = new GrowingByteBuffer()
    const bytes = Buffer.from([0, 255, 128, 10, 0])
    buffer.append(bytes.subarray(0, 2))
    buffer.append(bytes.subarray(2))
    const taken = buffer.takeBuffer()
    expect(taken).toEqual(bytes)
    expect(buffer.byteLength).toBe(0)
    expect(buffer.takeBuffer()).toEqual(Buffer.alloc(0))
    buffer.append(Buffer.alloc(1024, 7))
    buffer.clear()
    expect(taken).toEqual(bytes)
  })

  it('retains 100,000 one-byte fragments in one growable allocation', () => {
    const buffer = new GrowingByteBuffer()
    const expected = Buffer.alloc(100_000)

    for (let index = 0; index < expected.byteLength; index += 1) {
      const value = index % 251
      expected[index] = value
      buffer.append(Uint8Array.of(value))
    }

    expect(buffer.byteLength).toBe(expected.byteLength)
    expect(buffer.takeString('latin1')).toBe(expected.toString('latin1'))
    expect(buffer.byteLength).toBe(0)
  })

  it('consumes delimited prefixes and retains a bounded suffix', () => {
    const buffer = new GrowingByteBuffer()
    for (const byte of Buffer.from('first\nsecond-tail')) {
      buffer.append(Uint8Array.of(byte))
    }

    const newline = buffer.indexOfByte(0x0a)
    expect(buffer.takePrefixString(newline)).toBe('first')
    buffer.discardPrefix(1)
    buffer.retainSuffix(4)

    expect(buffer.toString()).toBe('tail')
  })

  it('appends only a bounded copy from an oversized source chunk', () => {
    const buffer = new GrowingByteBuffer()
    buffer.append(Buffer.from('old'))
    const source = Buffer.from('discard-prefix-tail')

    buffer.appendRetainedSuffix(source, 4)
    source.fill(0)

    expect(buffer.byteLength).toBe(4)
    expect(buffer.toString()).toBe('tail')
  })

  it('keeps the newest bytes across bounded suffix appends', () => {
    const buffer = new GrowingByteBuffer()

    buffer.appendRetainedSuffix(Buffer.from('1234'), 6)
    buffer.appendRetainedSuffix(Buffer.from('5678'), 6)

    expect(buffer.toString()).toBe('345678')
  })

  it('reads and writes correctly after the head offset has advanced', () => {
    const buffer = new GrowingByteBuffer()
    buffer.append(Buffer.from('aaa\nbbb\nccc'))

    expect(buffer.takePrefixString(buffer.indexOfByte(0x0a))).toBe('aaa')
    buffer.discardPrefix(1)
    expect(buffer.indexOfByte(0x0a)).toBe(3)
    expect(buffer.byteLength).toBe(7)
    buffer.append(Buffer.from('!'))
    expect(buffer.toString()).toBe('bbb\nccc!')
    expect(buffer.takeBuffer()).toEqual(Buffer.from('bbb\nccc!'))
    expect(buffer.byteLength).toBe(0)
  })

  it('keeps a bounded suffix stable across many small appends without unbounded growth', () => {
    const buffer = new GrowingByteBuffer()
    let expected = ''
    for (let index = 0; index < 5_000; index += 1) {
      const chunk = String(index % 10).repeat(3)
      buffer.appendRetainedSuffix(Buffer.from(chunk), 64)
      expected = (expected + chunk).slice(-64)
    }

    expect(buffer.byteLength).toBe(64)
    expect(buffer.takeString()).toBe(expected)
  })
})
