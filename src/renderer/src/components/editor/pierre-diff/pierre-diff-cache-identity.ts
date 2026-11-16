import { cloneFileDiffMetadata, type FileDiffMetadata } from '@pierre/diffs'

type CachedIdentity = {
  original: string
  modified: string
  key: string
  diff?: FileDiffMetadata
}

const identities = new Map<string, CachedIdentity>()
const MAX_RETAINED_CHARACTERS = 4_000_000
let retainedCharacters = 0
let nextIdentity = 0

function characterCount(entry: CachedIdentity): number {
  return (
    entry.original.length +
    entry.modified.length +
    (entry.diff?.additionCharacterCount ?? 0) +
    (entry.diff?.deletionCharacterCount ?? 0)
  )
}

export function getCachedPierreDiff(identity: string): FileDiffMetadata | undefined {
  for (const entry of identities.values()) {
    if (entry.key === identity && entry.diff) {
      return cloneFileDiffMetadata(entry.diff)
    }
  }
  return undefined
}

export function cachePierreDiff(identity: string, diff: FileDiffMetadata): void {
  for (const entry of identities.values()) {
    if (entry.key === identity) {
      retainedCharacters -= characterCount(entry)
      entry.diff = cloneFileDiffMetadata(diff)
      retainedCharacters += characterCount(entry)
      evictOldestIdentities()
      return
    }
  }
}

// Pierre uses cache keys as content equality, including across mounted surfaces.
export function getPierreDiffCacheIdentity(
  scope: string,
  original: string,
  modified: string
): string {
  const previous = identities.get(scope)
  if (previous?.original === original && previous.modified === modified) {
    identities.delete(scope)
    identities.set(scope, previous)
    return previous.key
  }
  if (previous) {
    retainedCharacters -= characterCount(previous)
    identities.delete(scope)
  }
  const key = `orca-diff:${++nextIdentity}`
  identities.set(scope, { original, modified, key })
  retainedCharacters += original.length + modified.length
  evictOldestIdentities()
  return key
}

function evictOldestIdentities(): void {
  // Why: a single diff can exceed the cap (4e6–6e6 sits under the large-diff render gate).
  // Evicting it immediately would mint a new identity on every remount and defeat Pierre's AST cache.
  while (
    identities.size > 64 ||
    (retainedCharacters > MAX_RETAINED_CHARACTERS && identities.size > 1)
  ) {
    const oldest = identities.entries().next().value
    if (!oldest) {
      break
    }
    retainedCharacters -= characterCount(oldest[1])
    identities.delete(oldest[0])
  }
}
