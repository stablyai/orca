import { closeSync, openSync, writeSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

// Why 16K code units: JS string slicing is code-unit based. This keeps each
// UTF-8 Buffer comfortably below 64KiB even for non-ASCII JSON content.
const UTF8_WRITE_CHUNK_CODE_UNITS = 16_384

type Utf8FileWriteOptions = {
  readonly mode?: number
}

/**
 * Write `contents` to `path` in small UTF-8 chunks.
 *
 * Why not writeFile/writeFileSync(path, contents): Electron's bundled Node can
 * abort the process when encoding a large string to UTF-8 in one filesystem
 * write. Each slice is encoded to a small Buffer first, so fs never receives a
 * large string and surrogate pairs stay intact.
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
  let index = 0
  while (index < contents.length) {
    const end = getNextChunkEnd(contents, index)
    writeBufferFullySync(fd, Buffer.from(contents.slice(index, end), 'utf8'))
    index = end
  }
}

async function writeUtf8StringToHandleInChunks(
  handle: FileHandle,
  contents: string
): Promise<void> {
  let index = 0
  while (index < contents.length) {
    const end = getNextChunkEnd(contents, index)
    await writeBufferFully(handle, Buffer.from(contents.slice(index, end), 'utf8'))
    index = end
  }
}

function openPathForWrite(path: string, options: Utf8FileWriteOptions): Promise<FileHandle> {
  return options.mode === undefined ? open(path, 'w') : open(path, 'w', options.mode)
}

function openPathForWriteSync(path: string, options: Utf8FileWriteOptions): number {
  return options.mode === undefined ? openSync(path, 'w') : openSync(path, 'w', options.mode)
}

function getNextChunkEnd(contents: string, index: number): number {
  let end = Math.min(index + UTF8_WRITE_CHUNK_CODE_UNITS, contents.length)
  const lastUnit = contents.charCodeAt(end - 1)
  if (end < contents.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    end -= 1
  }
  return end
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
