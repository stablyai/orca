import { measureClipboardTextByteLength } from './clipboard-text'
import { getUtf8ChunkEndIndex } from './utf8-byte-limits'

export const BROWSER_TEXT_INSERT_CHUNK_BYTES = 64 * 1024

export function splitBrowserTextInsertionChunks(
  text: string,
  maxChunkBytes = BROWSER_TEXT_INSERT_CHUNK_BYTES
): string[] {
  return [...iterateBrowserTextInsertionChunks(text, maxChunkBytes)]
}

export function* iterateBrowserTextInsertionChunks(
  text: string,
  maxChunkBytes = BROWSER_TEXT_INSERT_CHUNK_BYTES
): Generator<string> {
  if (text.length === 0) {
    return
  }
  const normalizedMax = Number.isFinite(maxChunkBytes) && maxChunkBytes > 0 ? maxChunkBytes : 1
  const measurement = measureClipboardTextByteLength(text, { stopAfterBytes: normalizedMax })
  if (!measurement.exceededLimit) {
    yield text
    return
  }

  let startIndex = 0
  while (startIndex < text.length) {
    const endIndex = getUtf8ChunkEndIndex(text, startIndex, normalizedMax)
    yield text.slice(startIndex, endIndex)
    startIndex = endIndex
  }
}
