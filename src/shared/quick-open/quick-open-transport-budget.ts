/** Byte accounting for the JSON array returned by files.listAll. */
export function serializedQuickOpenPathBytes(path: string): number {
  return Buffer.byteLength(JSON.stringify(path), 'utf8')
}

type QuickOpenSearchReply = {
  files: readonly unknown[]
  totalCount: number
  truncated: boolean
}

/** Keep a ranked Quick Open RPC reply below the request-scoped content ceiling. */
export function limitQuickOpenSearchReplyBySerializedBytes<T extends QuickOpenSearchReply>(
  result: T,
  maxBytes: number
): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) {
    return result
  }

  for (let length = result.files.length - 1; length >= 0; length -= 1) {
    const bounded = { ...result, files: result.files.slice(0, length), truncated: true } as T
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= maxBytes) {
      return bounded
    }
  }

  throw new Error('Quick Open search result exceeds the remote transport budget')
}

export function limitQuickOpenFilesBySerializedBytes(
  files: readonly string[],
  maxBytes: number
): string[] {
  const bounded: string[] = []
  let serializedBytes = 2 // []
  for (const path of files) {
    const nextBytes = serializedQuickOpenPathBytes(path) + (bounded.length === 0 ? 0 : 1)
    if (serializedBytes + nextBytes > maxBytes) {
      break
    }
    bounded.push(path)
    serializedBytes += nextBytes
  }
  return bounded
}
