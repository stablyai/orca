import { closeSync, lstatSync, openSync, readSync, statSync } from 'node:fs'

export const NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES = 64 * 1024

function readChunk(descriptor: number, buffer: Buffer): number {
  let offset = 0
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null)
    if (bytesRead === 0) {
      break
    }
    offset += bytesRead
  }
  return offset
}

export function nodeSourceAndCopyContentsEqualSync(sourcePath: string, copyPath: string): boolean {
  try {
    // Why: source links are intentional, but an owned copy must remain a regular file.
    if (!statSync(sourcePath).isFile() || !lstatSync(copyPath).isFile()) {
      return false
    }
  } catch {
    return false
  }

  let sourceDescriptor: number | null = null
  let copyDescriptor: number | null = null
  let matches = false
  let failed = false
  try {
    sourceDescriptor = openSync(sourcePath, 'r')
    copyDescriptor = openSync(copyPath, 'r')
    const sourceBuffer = Buffer.allocUnsafe(NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES)
    const copyBuffer = Buffer.allocUnsafe(NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES)
    while (true) {
      const sourceBytes = readChunk(sourceDescriptor, sourceBuffer)
      const copyBytes = readChunk(copyDescriptor, copyBuffer)
      if (sourceBytes !== copyBytes) {
        break
      }
      if (sourceBytes === 0) {
        matches = true
        break
      }
      if (!sourceBuffer.subarray(0, sourceBytes).equals(copyBuffer.subarray(0, copyBytes))) {
        break
      }
    }
  } catch {
    failed = true
  }
  for (const descriptor of [sourceDescriptor, copyDescriptor]) {
    if (descriptor === null) {
      continue
    }
    try {
      closeSync(descriptor)
    } catch {
      failed = true
    }
  }
  return matches && !failed
}
