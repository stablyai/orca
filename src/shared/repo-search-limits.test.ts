import { describe, expect, it } from 'vitest'
import {
  clampRepoSearchRefsLimit,
  clampRepoSearchRefsScanLimit,
  getRepoSearchRefsProbeLimit,
  isRepoSearchRefsRequestLimit,
  isRepoSearchRefsLimit,
  isRepoSearchRefsScanLimit,
  REPO_SEARCH_REFS_DEFAULT_LIMIT,
  REPO_SEARCH_REFS_MAX_LIMIT,
  REPO_SEARCH_REFS_MAX_SCAN_LIMIT
} from './repo-search-limits'

describe('repository ref-search limits', () => {
  it('accepts normal UI and CLI limits and adds one bounded probe row', () => {
    expect(REPO_SEARCH_REFS_DEFAULT_LIMIT).toBe(25)
    expect(isRepoSearchRefsLimit(20)).toBe(true)
    expect(isRepoSearchRefsLimit(REPO_SEARCH_REFS_DEFAULT_LIMIT)).toBe(true)
    expect(isRepoSearchRefsLimit(600)).toBe(true)
    expect(isRepoSearchRefsLimit(REPO_SEARCH_REFS_MAX_LIMIT)).toBe(true)
    expect(getRepoSearchRefsProbeLimit(20)).toBe(21)
    expect(getRepoSearchRefsProbeLimit(REPO_SEARCH_REFS_MAX_LIMIT)).toBe(
      REPO_SEARCH_REFS_MAX_SCAN_LIMIT
    )
    expect(isRepoSearchRefsRequestLimit(REPO_SEARCH_REFS_MAX_LIMIT + 1)).toBe(true)
    expect(clampRepoSearchRefsLimit(REPO_SEARCH_REFS_MAX_LIMIT + 1)).toBe(
      REPO_SEARCH_REFS_MAX_LIMIT
    )
    expect(clampRepoSearchRefsScanLimit(Number.MAX_SAFE_INTEGER)).toBe(
      REPO_SEARCH_REFS_MAX_SCAN_LIMIT
    )
  })

  it('accepts only the extra max scan row as a scan limit', () => {
    expect(isRepoSearchRefsScanLimit(REPO_SEARCH_REFS_MAX_LIMIT)).toBe(true)
    expect(isRepoSearchRefsScanLimit(REPO_SEARCH_REFS_MAX_SCAN_LIMIT)).toBe(true)
    expect(isRepoSearchRefsLimit(REPO_SEARCH_REFS_MAX_SCAN_LIMIT)).toBe(false)
  })

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_VALUE
  ])('rejects malformed request limit %s', (value) => {
    expect(isRepoSearchRefsRequestLimit(value)).toBe(false)
    expect(isRepoSearchRefsLimit(value)).toBe(false)
    expect(() => getRepoSearchRefsProbeLimit(value as number)).toThrow('invalid_limit')
    expect(() => clampRepoSearchRefsLimit(value as number)).toThrow('invalid_limit')
  })

  it('rejects a scan limit that would overflow the candidate multiplier', () => {
    expect(isRepoSearchRefsScanLimit(REPO_SEARCH_REFS_MAX_SCAN_LIMIT + 1)).toBe(false)
    expect(isRepoSearchRefsScanLimit(Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(isRepoSearchRefsScanLimit(Number.MAX_VALUE)).toBe(false)
  })

  it('uses the capped scan sentinel for oversized safe requests without overflowing', () => {
    expect(getRepoSearchRefsProbeLimit(REPO_SEARCH_REFS_MAX_LIMIT + 1)).toBe(
      REPO_SEARCH_REFS_MAX_SCAN_LIMIT
    )
    expect(getRepoSearchRefsProbeLimit(Number.MAX_SAFE_INTEGER)).toBe(
      REPO_SEARCH_REFS_MAX_SCAN_LIMIT
    )
  })
})
