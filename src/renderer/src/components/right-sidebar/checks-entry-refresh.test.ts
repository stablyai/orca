import { describe, expect, it } from 'vitest'
import { ENTRY_REFRESH_GRACE_MS, shouldEntryRefresh } from './checks-entry-refresh'

const NOW = 1_700_000_000_000

describe('shouldEntryRefresh', () => {
  it('refreshes when PR cache is missing (cold start, no PR known)', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: undefined,
        checksFetchedAt: undefined,
        commentsFetchedAt: undefined,
        prNumber: null,
        now: NOW
      })
    ).toBe(true)
  })

  it('refreshes when cached null PR result is older than the grace window', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - ENTRY_REFRESH_GRACE_MS - 1,
        checksFetchedAt: undefined,
        commentsFetchedAt: undefined,
        prNumber: null,
        now: NOW
      })
    ).toBe(true)
  })

  it('skips when cached null PR result is within the grace window', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 1_000,
        checksFetchedAt: undefined,
        commentsFetchedAt: undefined,
        prNumber: null,
        now: NOW
      })
    ).toBe(false)
  })

  it('refreshes when PR is known but checks cache is missing (first entry after app start)', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 1_000,
        checksFetchedAt: undefined,
        commentsFetchedAt: NOW - 1_000,
        prNumber: 42,
        now: NOW
      })
    ).toBe(true)
  })

  it('refreshes when PR is known but comments cache is missing', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 1_000,
        checksFetchedAt: NOW - 1_000,
        commentsFetchedAt: undefined,
        prNumber: 42,
        now: NOW
      })
    ).toBe(true)
  })

  it('refreshes when checks timestamp is older than the grace window', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 1_000,
        checksFetchedAt: NOW - ENTRY_REFRESH_GRACE_MS - 1,
        commentsFetchedAt: NOW - 1_000,
        prNumber: 42,
        now: NOW
      })
    ).toBe(true)
  })

  it('refreshes when comments timestamp is older than the grace window', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 1_000,
        checksFetchedAt: NOW - 1_000,
        commentsFetchedAt: NOW - ENTRY_REFRESH_GRACE_MS - 1,
        prNumber: 42,
        now: NOW
      })
    ).toBe(true)
  })

  it('skips when PR, checks, and comments are all fresh within the grace window', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 5_000,
        checksFetchedAt: NOW - 5_000,
        commentsFetchedAt: NOW - 5_000,
        prNumber: 42,
        now: NOW
      })
    ).toBe(false)
  })

  it('ignores checks/comments freshness when no PR is known', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 1_000,
        checksFetchedAt: undefined,
        commentsFetchedAt: undefined,
        prNumber: null,
        now: NOW
      })
    ).toBe(false)
  })

  it('treats a PR timestamp exactly at the cutoff as fresh', () => {
    // Why: the rule is "older than now - grace", strict less-than. Equal is fresh.
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - ENTRY_REFRESH_GRACE_MS,
        checksFetchedAt: NOW - ENTRY_REFRESH_GRACE_MS,
        commentsFetchedAt: NOW - ENTRY_REFRESH_GRACE_MS,
        prNumber: 42,
        now: NOW
      })
    ).toBe(false)
  })

  it('honors a custom graceMs override', () => {
    expect(
      shouldEntryRefresh({
        prFetchedAt: NOW - 2_000,
        checksFetchedAt: NOW - 2_000,
        commentsFetchedAt: NOW - 2_000,
        prNumber: 42,
        now: NOW,
        graceMs: 1_000
      })
    ).toBe(true)
  })
})
