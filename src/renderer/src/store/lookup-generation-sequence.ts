/** Use one never-reset process-wide lookup sequence. Per-key counters reused after eviction can let old replies impersonate current owners and discard newer work. Callers compare equality only, so sharing across caches/coordinators is safe. */
let lookupGenerationSequence = 0

export function nextLookupGeneration(): number {
  lookupGenerationSequence += 1
  return lookupGenerationSequence
}
