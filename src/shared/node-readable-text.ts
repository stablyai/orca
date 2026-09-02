const INITIAL_READ_CAPACITY_BYTES = 64 * 1024

export class NodeReadableTextTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`Input exceeds ${maxBytes} byte limit (${observedBytes} bytes received)`)
    this.name = 'NodeReadableTextTooLargeError'
  }
}

export async function readNodeReadableTextWithinLimit(
  readable: AsyncIterable<unknown>,
  maxBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Readable text limit must be a non-negative safe integer')
  }

  let buffer = Buffer.allocUnsafe(Math.min(INITIAL_READ_CAPACITY_BYTES, maxBytes))
  let bytes = 0
  for await (const value of readable) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    const observedBytes = bytes + chunk.byteLength
    if (!Number.isSafeInteger(observedBytes) || observedBytes > maxBytes) {
      throw new NodeReadableTextTooLargeError(observedBytes, maxBytes)
    }
    if (observedBytes > buffer.byteLength) {
      const nextCapacity = Math.min(
        maxBytes,
        Math.max(observedBytes, INITIAL_READ_CAPACITY_BYTES, buffer.byteLength * 2)
      )
      const expanded = Buffer.allocUnsafe(nextCapacity)
      buffer.copy(expanded, 0, 0, bytes)
      buffer = expanded
    }
    chunk.copy(buffer, bytes)
    bytes = observedBytes
  }
  return buffer.subarray(0, bytes).toString('utf8')
}
