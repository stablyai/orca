type CachedIdentity = { original: string; modified: string; key: string }

const identities = new Map<string, CachedIdentity>()
const MAX_RETAINED_CHARACTERS = 4_000_000
let retainedCharacters = 0
let nextIdentity = 0

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
    retainedCharacters -= previous.original.length + previous.modified.length
    identities.delete(scope)
  }
  const key = `orca-diff:${++nextIdentity}`
  identities.set(scope, { original, modified, key })
  retainedCharacters += original.length + modified.length
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
    retainedCharacters -= oldest[1].original.length + oldest[1].modified.length
    identities.delete(oldest[0])
  }
  return key
}
