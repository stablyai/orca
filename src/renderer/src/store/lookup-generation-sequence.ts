/** Use one never-reset process-wide lookup sequence. Per-key counters reused after eviction can let old replies impersonate current owners and discard newer work. It only grows, so sharing across caches/coordinators is safe for equality and for "issued after" checks. */
let lookupGenerationSequence = 0

export function nextLookupGeneration(): number {
  lookupGenerationSequence += 1
  return lookupGenerationSequence
}

/** Every request issued after this call gets a larger generation. */
export function latestLookupGeneration(): number {
  return lookupGenerationSequence
}
