import { open } from 'node:fs/promises'

export type ArtifactFileReadResult =
  | { status: 'ok'; content: string }
  | { status: 'not-file' }
  | { status: 'empty' }
  | { status: 'too-large' }

export async function readArtifactFileWithinLimit(
  path: string,
  maxBytes: number
): Promise<ArtifactFileReadResult> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) {
    return { status: 'not-file' }
  }
  try {
    const fileStats = await handle.stat().catch(() => null)
    if (!fileStats?.isFile()) {
      return { status: 'not-file' }
    }
    if (fileStats.size > maxBytes) {
      return { status: 'too-large' }
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null)
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxBytes) {
      return { status: 'too-large' }
    }
    if (bytesRead === 0) {
      return { status: 'empty' }
    }
    return { status: 'ok', content: buffer.subarray(0, bytesRead).toString('utf8') }
  } finally {
    await handle.close()
  }
}
