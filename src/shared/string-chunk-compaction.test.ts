import { describe, expect, it } from 'vitest'
import { appendCompactedStringChunk, RETAINED_STRING_CHUNK_LIMIT } from './string-chunk-compaction'

describe('appendCompactedStringChunk', () => {
  it('preserves 100,000 fragments within the retained chunk limit', () => {
    const chunks: string[] = []
    let maxRetainedChunks = 0

    for (let index = 0; index < 100_000; index += 1) {
      appendCompactedStringChunk(chunks, String.fromCharCode(97 + (index % 26)))
      maxRetainedChunks = Math.max(maxRetainedChunks, chunks.length)
    }

    expect(maxRetainedChunks).toBeLessThanOrEqual(RETAINED_STRING_CHUNK_LIMIT)
    expect(chunks.join('')).toHaveLength(100_000)
  })
})
