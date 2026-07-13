export const GIT_CHECK_IGNORE_TIMEOUT_MS = 15_000
export const GIT_CHECK_IGNORE_STDIN_CHUNK_BYTES = 1024 * 1024

export const GIT_CHECK_IGNORE_STDIN_ARGS = [
  '-c',
  'core.quotePath=false',
  'check-ignore',
  '-z',
  '--stdin'
] as const

export function encodeGitCheckIgnorePaths(paths: readonly string[]): string {
  return `${paths.join('\0')}\0`
}

export function splitGitCheckIgnorePathsByStdinBytes(
  paths: readonly string[],
  maxBytes: number = GIT_CHECK_IGNORE_STDIN_CHUNK_BYTES
): string[][] {
  const encoder = new TextEncoder()
  const chunks: string[][] = []
  let chunk: string[] = []
  let chunkBytes = 0
  for (const path of paths) {
    const pathBytes = encoder.encode(path).byteLength + 1
    if (chunk.length > 0 && chunkBytes + pathBytes > maxBytes) {
      chunks.push(chunk)
      chunk = []
      chunkBytes = 0
    }
    chunk.push(path)
    chunkBytes += pathBytes
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }
  return chunks
}

export function parseGitCheckIgnorePaths(stdout: string): string[] {
  return stdout.split('\0').filter((path) => path.length > 0)
}
