export const RUNTIME_REPO_REF_SEARCH_QUERY_MAX_BYTES = 2 * 1024

function getCodePointUtf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

export function isRuntimeRepoRefSearchQueryWithinLimit(
  query: string,
  maxBytes = RUNTIME_REPO_REF_SEARCH_QUERY_MAX_BYTES
): boolean {
  let byteLength = 0
  for (let index = 0; index < query.length; index += 1) {
    const codePoint = query.codePointAt(index) ?? 0
    byteLength += getCodePointUtf8ByteLength(codePoint)
    if (byteLength > maxBytes) {
      return false
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return true
}
