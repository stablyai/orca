/**
 * Id source for the generation stamps that decide which in-flight lookup owns a
 * cache key — shared by the pull-request and hosted-review request coordinators.
 *
 * Both delete a key's generation entry once its newest lookup settles, so a
 * per-key counter restarts at 1 while an older lookup of the same key is still
 * out: that straggler then reads as the current owner, publishes its stale
 * answer, and tears down the live newer lookup's ownership so the fresh answer
 * is dropped. Ids that are never reused remove the collision.
 *
 * Deliberately has no reset: only equality is ever compared, so one sequence can
 * serve every cache, and rewinding it while a lookup is out recreates the very
 * collision this exists to prevent.
 */
let lookupGenerationSequence = 0

export function nextLookupGeneration(): number {
  lookupGenerationSequence += 1
  return lookupGenerationSequence
}
