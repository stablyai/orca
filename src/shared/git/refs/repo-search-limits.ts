/** The branch picker asks for 20; keep the API default aligned with legacy callers. */
export const REPO_SEARCH_REFS_DEFAULT_LIMIT = 25

/** Keep Git's `for-each-ref --count` finite for API and CLI callers. */
export const REPO_SEARCH_REFS_MAX_LIMIT = 1_000

/** One extra row lets runtime callers report whether the page was truncated. */
export const REPO_SEARCH_REFS_MAX_SCAN_LIMIT = REPO_SEARCH_REFS_MAX_LIMIT + 1

/** A positive safe integer is a valid caller request; the execution cap is applied separately. */
export function isRepoSearchRefsRequestLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isRepoSearchRefsLimit(value: unknown): value is number {
  return isRepoSearchRefsRequestLimit(value) && value <= REPO_SEARCH_REFS_MAX_LIMIT
}

export function isRepoSearchRefsScanLimit(value: unknown): value is number {
  return isRepoSearchRefsRequestLimit(value) && value <= REPO_SEARCH_REFS_MAX_SCAN_LIMIT
}

/** Clamp a validated request before it reaches a Git command or retained result array. */
export function clampRepoSearchRefsLimit(limit: number): number {
  if (!isRepoSearchRefsRequestLimit(limit)) {
    throw new Error('invalid_limit')
  }
  return Math.min(limit, REPO_SEARCH_REFS_MAX_LIMIT)
}

/** Clamp an internal probe count, retaining room for the runtime truncation sentinel. */
export function clampRepoSearchRefsScanLimit(limit: number): number {
  if (!isRepoSearchRefsRequestLimit(limit)) {
    throw new Error('invalid_limit')
  }
  return Math.min(limit, REPO_SEARCH_REFS_MAX_SCAN_LIMIT)
}

export function getRepoSearchRefsProbeLimit(limit: number): number {
  if (!isRepoSearchRefsRequestLimit(limit)) {
    throw new Error('invalid_limit')
  }
  // Avoid `limit + 1` at MAX_SAFE_INTEGER; the capped sentinel is all callers need.
  return limit >= REPO_SEARCH_REFS_MAX_LIMIT ? REPO_SEARCH_REFS_MAX_SCAN_LIMIT : limit + 1
}
