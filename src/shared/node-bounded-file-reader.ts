import { closeSync, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'

const MIN_GROWTH_BYTES = 64 * 1024

export class NodeFileReadTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(
      `File too large: ${(observedBytes / 1024 / 1024).toFixed(1)}MB exceeds ${maxBytes / 1024 / 1024}MB limit`
    )
    this.name = 'NodeFileReadTooLargeError'
  }
}

export type BoundedNodeFileRead = {
  buffer: Buffer
  stats: Stats
}

function validateSize(size: number, maxBytes: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('File has an invalid byte size')
  }
  if (size > maxBytes) {
    throw new NodeFileReadTooLargeError(size, maxBytes)
  }
}

export async function readNodeFileWithinLimit(
  filePath: string,
  maxBytes: number
): Promise<BoundedNodeFileRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('File read limit must be a non-negative safe integer')
  }

  const handle = await open(filePath, 'r')
  try {
    const stats = await handle.stat()
    validateSize(stats.size, maxBytes)

    let buffer = Buffer.allocUnsafe(stats.size)
    let offset = 0
    while (true) {
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) {
          return { buffer: buffer.subarray(0, offset), stats }
        }
        offset += bytesRead
      }

      const probe = Buffer.allocUnsafe(1)
      const { bytesRead } = await handle.read(probe, 0, 1, offset)
      if (bytesRead === 0) {
        return { buffer: buffer.subarray(0, offset), stats }
      }
      if (offset >= maxBytes) {
        throw new NodeFileReadTooLargeError(offset + bytesRead, maxBytes)
      }

      // Why: ordinary readFile includes concurrent growth, so retain that behavior while capacity stays bounded.
      const nextCapacity = Math.min(
        maxBytes,
        Math.max(MIN_GROWTH_BYTES, buffer.length * 2, offset + bytesRead)
      )
      const expanded = Buffer.allocUnsafe(nextCapacity)
      buffer.copy(expanded, 0, 0, offset)
      expanded[offset] = probe[0]!
      buffer = expanded
      offset += bytesRead
    }
  } finally {
    await handle.close()
  }
}

export function readNodeFileSyncWithinLimit(
  filePath: string,
  maxBytes: number
): BoundedNodeFileRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('File read limit must be a non-negative safe integer')
  }

  const descriptor = openSync(filePath, 'r')
  try {
    const stats = fstatSync(descriptor)
    validateSize(stats.size, maxBytes)

    let buffer = Buffer.allocUnsafe(stats.size)
    let offset = 0
    while (true) {
      while (offset < buffer.length) {
        const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) {
          return { buffer: buffer.subarray(0, offset), stats }
        }
        offset += bytesRead
      }

      const probe = Buffer.allocUnsafe(1)
      const bytesRead = readSync(descriptor, probe, 0, 1, offset)
      if (bytesRead === 0) {
        return { buffer: buffer.subarray(0, offset), stats }
      }
      if (offset >= maxBytes) {
        throw new NodeFileReadTooLargeError(offset + bytesRead, maxBytes)
      }

      const nextCapacity = Math.min(
        maxBytes,
        Math.max(MIN_GROWTH_BYTES, buffer.length * 2, offset + bytesRead)
      )
      const expanded = Buffer.allocUnsafe(nextCapacity)
      buffer.copy(expanded, 0, 0, offset)
      expanded[offset] = probe[0]!
      buffer = expanded
      offset += bytesRead
    }
  } finally {
    closeSync(descriptor)
  }
}
