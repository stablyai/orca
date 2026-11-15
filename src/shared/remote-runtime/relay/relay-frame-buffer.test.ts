import { describe, expect, it } from 'vitest'
import { RelayFrameBuffer } from './relay-frame-buffer'

describe('RelayFrameBuffer', () => {
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
