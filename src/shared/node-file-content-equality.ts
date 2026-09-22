import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { open } from 'node:fs/promises'

export const NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES = 64 * 1024

function expectedBytes(contents: string | Buffer): Buffer {
  return typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents
}

export async function nodeFileContentsEqual(
  filePath: string,
  expectedContents: string | Buffer
): Promise<boolean> {
  const expected = expectedBytes(expectedContents)
  const handle = await open(filePath, 'r')
  try {
    if ((await handle.stat()).size !== expected.length) {
      return false
    }
    const chunk = Buffer.allocUnsafe(
      Math.min(NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES, expected.length)
    )
    let offset = 0
    while (offset < expected.length) {
      const length = Math.min(chunk.length, expected.length - offset)
      const { bytesRead } = await handle.read(chunk, 0, length, offset)
      if (
        bytesRead === 0 ||
        !chunk.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))
      ) {
        return false
      }
      offset += bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    return (await handle.read(probe, 0, 1, offset)).bytesRead === 0
  } finally {
    await handle.close()
  }
}

export function nodeFileContentsEqualSync(
  filePath: string,
  expectedContents: string | Buffer
): boolean {
  const expected = expectedBytes(expectedContents)
  const descriptor = openSync(filePath, 'r')
  try {
    if (fstatSync(descriptor).size !== expected.length) {
      return false
    }
    const chunk = Buffer.allocUnsafe(
      Math.min(NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES, expected.length)
    )
    let offset = 0
    while (offset < expected.length) {
      const length = Math.min(chunk.length, expected.length - offset)
      const bytesRead = readSync(descriptor, chunk, 0, length, offset)
      if (
        bytesRead === 0 ||
        !chunk.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))
      ) {
        return false
      }
      offset += bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    return readSync(descriptor, probe, 0, 1, offset) === 0
  } finally {
    closeSync(descriptor)
  }
}

export function nodeFilesEqualSync(leftPath: string, rightPath: string): boolean {
  const left = openSync(leftPath, 'r')
  try {
    const right = openSync(rightPath, 'r')
    try {
      const size = fstatSync(left).size
      if (fstatSync(right).size !== size) {
        return false
      }
      const chunkBytes = Math.min(NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES, Math.max(1, size))
      const leftChunk = Buffer.allocUnsafe(chunkBytes)
      const rightChunk = Buffer.allocUnsafe(chunkBytes)
      let offset = 0
      while (offset < size) {
        const length = Math.min(chunkBytes, size - offset)
        if (
          !readCompleteChunk(left, leftChunk, length, offset) ||
          !readCompleteChunk(right, rightChunk, length, offset) ||
          !leftChunk.subarray(0, length).equals(rightChunk.subarray(0, length))
        ) {
          return false
        }
        offset += length
      }
      // A file that grew after stat must not compare equal to the original prefix.
      return (
        readSync(left, leftChunk, 0, 1, offset) === 0 &&
        readSync(right, rightChunk, 0, 1, offset) === 0
      )
    } finally {
      closeSync(right)
    }
  } finally {
    closeSync(left)
  }
}

function readCompleteChunk(
  descriptor: number,
  chunk: Buffer,
  length: number,
  position: number
): boolean {
  let offset = 0
  while (offset < length) {
    const bytesRead = readSync(descriptor, chunk, offset, length - offset, position + offset)
    if (bytesRead === 0) {
      return false
    }
    offset += bytesRead
  }
  return true
}
