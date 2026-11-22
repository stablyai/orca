export type LocalImageSrcStatus = 'loading' | 'ready' | 'failed'

/** What produced the value on screen: a URL kept from an older read must not count as current. */
export type LocalImageSrcOutcome = { key: string; generation: number; found: boolean }

/** Ready or failed only for a result of the current key and cache generation; loading otherwise. */
export function localImageSrcStatus({
  external,
  cacheKey,
  outcome,
  generation
}: {
  external: boolean
  cacheKey: string | null
  outcome: LocalImageSrcOutcome | undefined
  generation: number
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
  return outcome.found ? 'ready' : 'failed'
}
