export type LocalImageSrcStatus = 'loading' | 'ready' | 'failed'

/** What produced the value on screen: a URL kept from an older read must not count as current. */
export type LocalImageSrcOutcome = { key: string; generation: number; found: boolean }

/** Ready or failed only for a result of the current key and cache generation, and ready only while
 *  the cache still owns that URL: an evicted entry's URL is revoked even though nothing reread it. */
export function localImageSrcStatus({
  external,
  cacheKey,
  outcome,
  generation,
  owned
}: {
  external: boolean
  cacheKey: string | null
  outcome: LocalImageSrcOutcome | undefined
  generation: number
  /** The cache still holds the URL on screen for this key. */
  owned: boolean
}): LocalImageSrcStatus {
  if (external) {
    return 'ready'
  }
  if (!cacheKey) {
    return 'failed'
  }
  if (outcome?.key !== cacheKey || outcome.generation !== generation) {
    return 'loading'
  }
  return !outcome.found ? 'failed' : owned ? 'ready' : 'loading'
}
