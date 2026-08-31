import { Buffer } from 'node:buffer'

/**
 * Collects output up to a cap, so a chatty child cannot grow the heap.
 *
 * Accepts strings as well as buffers: a stream someone called `setEncoding` on
 * emits strings, and concatenating those as buffers throws inside a `data`
 * handler, where the rejection has nowhere to go and the caller just hangs.
 */
export function createOutputSink(maxBytes: number): {
  write: (chunk: Buffer | string) => void
  text: () => string
} {
  const chunks: Buffer[] = []
  let bytes = 0
  return {
    write(raw) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        return
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      bytes += chunk.length
    },
    text: () => Buffer.concat(chunks).toString('utf8')
  }
}
