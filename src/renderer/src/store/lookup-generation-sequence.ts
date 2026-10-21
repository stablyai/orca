/**
 * Id source for the generation stamps that decide which in-flight lookup owns a
 * cache key. One counter, allocated from for the life of the process, serves
 * every cache and every coordinator that needs such a stamp.
 *
 * A coordinator that drops a key's generation entry once its newest lookup
 * settles lets a per-key counter restart at 1 while an older lookup of the same
 * key is still out: that straggler then reads as the current owner, publishes
 * its stale answer, and tears down the live newer lookup's ownership so the
 * fresh answer is dropped. Ids that are never reused remove the collision.
 *
 * Callers only ever compare stamps for equality, never order or magnitude, so a
 * single shared sequence is safe no matter how many caches draw from it.
 * Deliberately has no reset: rewinding it while a lookup is out recreates the
 * very collision this exists to prevent.
 */
let lookupGenerationSequence = 0

export function nextLookupGeneration(): number {
  lookupGenerationSequence += 1
  return lookupGenerationSequence
}
