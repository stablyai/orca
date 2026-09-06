/**
 * FNV-1a stamp for one editor draft's text.
 *
 * Why its own module: it is the single hash shared by the mobile sync key and the mobile session
 * snapshot, and its cost is proportional to the draft's length — so callers must memoize it per
 * file rather than re-running it whenever the drafts record is re-spread.
 */
export function stableHashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `draft:${value.length}:${(hash >>> 0).toString(16)}`
}
