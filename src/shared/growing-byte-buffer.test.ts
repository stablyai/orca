import { describe, expect, it } from 'vitest'
import { GrowingByteBuffer } from './growing-byte-buffer'

describe('GrowingByteBuffer', () => {
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
})
