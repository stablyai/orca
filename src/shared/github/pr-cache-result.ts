import type { PRInfo } from './pull-request-types'
import { withBoundedCacheEntry } from './cache-eviction'

export type PRCacheEntry = {
  data: PRInfo | null
  fetchedAt: number
  fetchedHeadOid?: string | null
}

export function applyPRCacheResult(
  cache: Record<string, PRCacheEntry>,
  cacheKey: string,
  pr: PRInfo | null,
  fetchedAt: number,
  accepted: boolean,
  preserveExisting: boolean,
  fetchedHeadOid?: string | null
): Record<string, PRCacheEntry> {
  if (preserveExisting) {
    return cache
  }
  if (accepted) {
    return withBoundedCacheEntry(cache, cacheKey, {
      data: pr,
      fetchedAt,
      ...(fetchedHeadOid ? { fetchedHeadOid } : {})
    })
  }
  if (!cache[cacheKey]) {
    return cache
  }
  const next = { ...cache }
  delete next[cacheKey]
  return next
}

export function mergedPRMatchesHead(
  pr: PRInfo | null | undefined,
  currentHeadOid?: string | null
): boolean {
  return (
    pr?.state === 'merged' &&
    typeof pr.headSha === 'string' &&
    pr.headSha.length > 0 &&
    typeof currentHeadOid === 'string' &&
    currentHeadOid.length > 0 &&
    (pr.headSha === currentHeadOid || pr.confirmedContainedHeadOid === currentHeadOid)
  )
}

export function shouldPreserveMergedPRForFallbackMiss(args: {
  currentPR: PRInfo | null | undefined
  nextPR: PRInfo | null
  currentHeadOid?: string | null
  linkedPRNumber?: number | null
  rejectedPRUrls?: readonly string[]
}): boolean {
  const { currentPR, currentHeadOid } = args
  return (
    args.nextPR === null &&
    args.linkedPRNumber == null &&
    currentPR != null &&
    mergedPRMatchesHead(currentPR, currentHeadOid) &&
    !args.rejectedPRUrls?.includes(currentPR.url)
  )
}
