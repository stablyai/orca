import { closeSync, constants, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'

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

export class NodeFileNotRegularError extends Error {
  constructor() {
    super('Expected a regular file')
    this.name = 'NodeFileNotRegularError'
  }
}

export type BoundedNodeFileRead = {
  buffer: Buffer
  stats: Stats
}

type NodeFileReadOptions = {
  regularFileOnly?: boolean
  signal?: AbortSignal
  window?: { offset: number; length?: number }
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
  maxBytes: number,
  options: NodeFileReadOptions = {}
): Promise<BoundedNodeFileRead> {
  options.signal?.throwIfAborted()
  if (options.regularFileOnly && !(await stat(filePath)).isFile()) {
    throw new NodeFileNotRegularError()
  }
  options.signal?.throwIfAborted()
  // Nonblocking open fences replacement with a FIFO after the path check.
  const flags = options.regularFileOnly
    ? constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    : 'r'
  const handle = await open(filePath, flags)
  try {
    return await readNodeFileHandleWithinLimit(handle, maxBytes, options)
  } finally {
    await handle.close()
  }
}

export async function readNodeFileHandleWithinLimit(
  handle: FileHandle,
  maxBytes: number,
  options: NodeFileReadOptions = {}
): Promise<BoundedNodeFileRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('File read limit must be a non-negative safe integer')
  }

  options.signal?.throwIfAborted()
  const stats = await handle.stat()
  options.signal?.throwIfAborted()
  if (options.regularFileOnly && !stats.isFile()) {
    throw new NodeFileNotRegularError()
  }
  if (options.window) {
    validateSize(stats.size, Number.MAX_SAFE_INTEGER)
    const { offset, length = stats.size - options.window.offset } = options.window
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      throw new RangeError('File read window must contain non-negative safe integers')
    }
    validateSize(length, maxBytes)
    if (offset > stats.size || length > stats.size - offset) {
      throw new Error('File is smaller than the requested window')
    }
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
      options.signal?.throwIfAborted()
      if (bytesRead === 0) {
        throw new Error('File is smaller than the requested window')
      }
      read += bytesRead
    }
    return { buffer, stats }
  }
  validateSize(stats.size, maxBytes)

  // Sysctl files report zero size and may return EOF after a partial first read.
  let buffer = Buffer.allocUnsafe(stats.size || Math.min(MIN_GROWTH_BYTES, maxBytes))
  let offset = 0
  while (true) {
    options.signal?.throwIfAborted()
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      options.signal?.throwIfAborted()
      if (bytesRead === 0) {
        return { buffer: buffer.subarray(0, offset), stats }
      }
      offset += bytesRead
    }

    const probe = Buffer.allocUnsafe(1)
    const { bytesRead } = await handle.read(probe, 0, 1, offset)
    options.signal?.throwIfAborted()
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
}

export function readNodeFileSyncWithinLimit(
  filePath: string,
  maxBytes: number,
  options: { regularFileOnly?: boolean } = {}
): BoundedNodeFileRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('File read limit must be a non-negative safe integer')
  }

  if (options.regularFileOnly && !statSync(filePath).isFile()) {
    throw new NodeFileNotRegularError()
  }
  // Nonblocking open also fences replacement with a FIFO after the path check.
  const flags = options.regularFileOnly
    ? constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    : 'r'
  const descriptor = openSync(filePath, flags)
  try {
    const stats = fstatSync(descriptor)
    if (options.regularFileOnly && !stats.isFile()) {
      throw new NodeFileNotRegularError()
    }
    validateSize(stats.size, maxBytes)

    // Sysctl files report zero size and may return EOF after a partial first read.
    let buffer = Buffer.allocUnsafe(stats.size || Math.min(MIN_GROWTH_BYTES, maxBytes))
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
