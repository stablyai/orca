import { describe, expect, it } from 'vitest'
import { RelayFrameBuffer } from './relay-frame-buffer'

describe('RelayFrameBuffer', () => {
  it('preserves a byte stream across fragmented peeks, takes, discards and drains', () => {
    const buffer = new RelayFrameBuffer()
    let expected = Buffer.alloc(0)
    for (let step = 0; step < 5000; step += 1) {
      const chunk = Buffer.from([step % 256, (step + 1) % 256, (step + 2) % 256])
      buffer.append(chunk)
      expected = Buffer.concat([expected, chunk])
      if (step % 3 === 0) {
        const count = Math.min(expected.length, 5)
        expect(buffer.peek(count).subarray(0, count)).toEqual(expected.subarray(0, count))
        expect(buffer.take(count)).toEqual(expected.subarray(0, count))
        expected = expected.subarray(count)
      }
      if (step % 7 === 0) {
        const count = Math.min(expected.length, 4)
        buffer.discard(count)
        expected = expected.subarray(count)
      }
      if (step % 101 === 0) {
        expect(buffer.drain()).toEqual(expected)
        expected = Buffer.alloc(0)
      }
      expect(buffer.length).toBe(expected.length)
    }
    expect(buffer.drain()).toEqual(expected)
    expect(buffer.drain()).toEqual(Buffer.alloc(0))
  })

  it('keeps single-chunk views and clears partial data before reuse', () => {
    const buffer = new RelayFrameBuffer()
    const chunk = Buffer.from('abcdef')
    buffer.append(chunk)
    expect(buffer.peek(2)).toBe(chunk)
    const taken = buffer.take(2)
    expect(taken.buffer).toBe(chunk.buffer)
    expect(taken.toString()).toBe('ab')
    buffer.clear()
    buffer.append(Buffer.from('fresh'))
    expect(buffer.drain().toString()).toBe('fresh')
  })
})
