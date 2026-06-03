import { closeSync, openSync, writeSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

const UTF8_WRITE_BUFFER_BYTES = 16 * 1024
const REPLACEMENT_CHARACTER = 0xfffd
const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff
const LOW_SURROGATE_START = 0xdc00
const LOW_SURROGATE_END = 0xdfff

type Utf8FileWriteOptions = {
  readonly mode?: number
}

/**
 * Write `contents` to `path` in small UTF-8 chunks.
 *
 * Why not writeFile/writeFileSync(path, contents): Electron's bundled Node can
 * abort the process when encoding a large string to UTF-8 in one filesystem
 * write. It can also mis-encode some sparse non-ASCII strings through
 * Buffer.from(), so this path encodes small byte buffers manually.
 */
export async function writeUtf8FileInChunks(
  path: string,
  contents: string,
  options: Utf8FileWriteOptions = {}
): Promise<void> {
  const handle = await openPathForWrite(path, options)
  try {
    await writeUtf8StringToHandleInChunks(handle, contents)
  } finally {
    await handle.close()
  }
}

/**
 * Synchronous variant for shutdown and other paths that cannot wait on async IO.
 */
export function writeUtf8FileInChunksSync(
  path: string,
  contents: string,
  options: Utf8FileWriteOptions = {}
): void {
  const fd = openPathForWriteSync(path, options)
  try {
    writeUtf8StringToFdInChunksSync(fd, contents)
  } finally {
    closeSync(fd)
  }
}

export function writeUtf8StringToFdInChunksSync(fd: number, contents: string): void {
  for (const chunk of encodeUtf8Chunks(contents)) {
    writeBufferFullySync(fd, chunk)
  }
}

async function writeUtf8StringToHandleInChunks(
  handle: FileHandle,
  contents: string
): Promise<void> {
  for (const chunk of encodeUtf8Chunks(contents)) {
    await writeBufferFully(handle, chunk)
  }
}

function openPathForWrite(path: string, options: Utf8FileWriteOptions): Promise<FileHandle> {
  return options.mode === undefined ? open(path, 'w') : open(path, 'w', options.mode)
}

function openPathForWriteSync(path: string, options: Utf8FileWriteOptions): number {
  return options.mode === undefined ? openSync(path, 'w') : openSync(path, 'w', options.mode)
}

function* encodeUtf8Chunks(contents: string): Generator<Buffer> {
  const buffer = Buffer.allocUnsafe(UTF8_WRITE_BUFFER_BYTES)
  let offset = 0

  const reserve = (byteCount: number): Buffer | null => {
    if (offset + byteCount <= buffer.length) {
      return null
    }
    const chunk = buffer.subarray(0, offset)
    offset = 0
    return chunk
  }

  for (let index = 0; index < contents.length; index++) {
    const firstCodeUnit = contents.charCodeAt(index)

    if (firstCodeUnit < 0x80) {
      const chunk = reserve(1)
      if (chunk) {
        yield chunk
      }
      buffer[offset++] = firstCodeUnit
      continue
    }

    if (firstCodeUnit < 0x800) {
      const chunk = reserve(2)
      if (chunk) {
        yield chunk
      }
      buffer[offset++] = 0xc0 | (firstCodeUnit >> 6)
      buffer[offset++] = 0x80 | (firstCodeUnit & 0x3f)
      continue
    }

    if (firstCodeUnit >= HIGH_SURROGATE_START && firstCodeUnit <= HIGH_SURROGATE_END) {
      const secondCodeUnit = contents.charCodeAt(index + 1)
      if (secondCodeUnit >= LOW_SURROGATE_START && secondCodeUnit <= LOW_SURROGATE_END) {
        const codePoint =
          0x10000 +
          ((firstCodeUnit - HIGH_SURROGATE_START) << 10) +
          (secondCodeUnit - LOW_SURROGATE_START)
        index++
        const chunk = reserve(4)
        if (chunk) {
          yield chunk
        }
        buffer[offset++] = 0xf0 | (codePoint >> 18)
        buffer[offset++] = 0x80 | ((codePoint >> 12) & 0x3f)
        buffer[offset++] = 0x80 | ((codePoint >> 6) & 0x3f)
        buffer[offset++] = 0x80 | (codePoint & 0x3f)
        continue
      }
      const chunk = reserve(3)
      if (chunk) {
        yield chunk
      }
      writeThreeByteCodePoint(buffer, offset, REPLACEMENT_CHARACTER)
      offset += 3
      continue
    }

    const codePoint =
      firstCodeUnit >= LOW_SURROGATE_START && firstCodeUnit <= LOW_SURROGATE_END
        ? REPLACEMENT_CHARACTER
        : firstCodeUnit
    const chunk = reserve(3)
    if (chunk) {
      yield chunk
    }
    writeThreeByteCodePoint(buffer, offset, codePoint)
    offset += 3
  }

  if (offset > 0) {
    yield buffer.subarray(0, offset)
  }
}

function writeThreeByteCodePoint(buffer: Buffer, offset: number, codePoint: number): void {
  buffer[offset] = 0xe0 | (codePoint >> 12)
  buffer[offset + 1] = 0x80 | ((codePoint >> 6) & 0x3f)
  buffer[offset + 2] = 0x80 | (codePoint & 0x3f)
}

function writeBufferFullySync(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.byteLength) {
    const bytesWritten = writeSync(fd, buffer, offset, buffer.byteLength - offset)
    if (bytesWritten === 0) {
      throw new Error('Failed to write UTF-8 file chunk')
    }
    offset += bytesWritten
  }
}

async function writeBufferFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset)
    if (bytesWritten === 0) {
      throw new Error('Failed to write UTF-8 file chunk')
    }
    offset += bytesWritten
  }
}
