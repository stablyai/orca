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

let syncCompareChunk: Buffer | null = null
const syncCompareProbe = Buffer.allocUnsafe(1)

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
    if (expected.length > 0) {
      // Synchronous readSync cannot re-enter; reuse one scratch chunk across startup sweeps.
      syncCompareChunk ??= Buffer.allocUnsafe(NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES)
      let offset = 0
      while (offset < expected.length) {
        const length = Math.min(syncCompareChunk.length, expected.length - offset)
        const bytesRead = readSync(descriptor, syncCompareChunk, 0, length, offset)
        if (
          bytesRead === 0 ||
          !syncCompareChunk
            .subarray(0, bytesRead)
            .equals(expected.subarray(offset, offset + bytesRead))
        ) {
          return false
        }
        offset += bytesRead
      }
    }
    return readSync(descriptor, syncCompareProbe, 0, 1, expected.length) === 0
  } finally {
    closeSync(descriptor)
  }
}
