import type { TokenCandidate } from './match-document'

export function compareSelectedSourceOrder(
  a: readonly TokenCandidate[],
  b: readonly TokenCandidate[]
): number {
  for (let tokenIndex = 0; tokenIndex < a.length; tokenIndex += 1) {
    const aHits = a[tokenIndex].hits
    const bHits = b[tokenIndex].hits
    for (let hitIndex = 0; hitIndex < Math.max(aHits.length, bHits.length); hitIndex += 1) {
      if (hitIndex >= aHits.length || hitIndex >= bHits.length) {
        return aHits.length - bHits.length
      }
      const difference = aHits[hitIndex].field.sourceOrder - bHits[hitIndex].field.sourceOrder
      if (difference !== 0) {
        return difference
      }
    }
  }
  return 0
}
