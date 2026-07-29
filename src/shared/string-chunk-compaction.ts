export const RETAINED_STRING_CHUNK_LIMIT = 1_024

export function appendCompactedStringChunk(chunks: string[], value: string): void {
  chunks.push(value)
  if (chunks.length <= RETAINED_STRING_CHUNK_LIMIT) {
    return
  }
  const compacted = chunks.join('')
  chunks.length = 0
  chunks.push(compacted)
}
