// Rotate retained diff-model identities when fetched blobs change, avoiding stale paint without remounting on each edit.
export function getDiffContentSignature(content: string): string {
  let hash = 2166136261
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
