import { describe, expect, it } from 'vitest'
import {
  BROWSER_RETENTION_LIMIT,
  selectBrowserRetentionEvictions,
  type BrowserRetentionBudget,
  type BrowserRetentionCandidate
} from './browser-retention-budget'

const NOW = 1_000_000

/** The headless host's shape: a clock rule on top of the rank rule. */
const HEADLESS: BrowserRetentionBudget = {
  limit: 2,
  idleMs: 60_000,
  graceMs: 5_000
}
/** The desktop host's shape: rank only, no clock. */
const DESKTOP: BrowserRetentionBudget = {
  limit: 2,
  idleMs: Number.POSITIVE_INFINITY,
  graceMs: 0
}

function used(id: string, msAgo: number): BrowserRetentionCandidate {
  return { id, lastActivityAt: NOW - msAgo }
}

function select(
  candidates: readonly BrowserRetentionCandidate[],
  budget: BrowserRetentionBudget,
  pinned: readonly string[] = []
): string[] {
  return selectBrowserRetentionEvictions({
    candidates,
    isPinned: (id) => pinned.includes(id),
    now: NOW,
    budget
  })
}

describe('selectBrowserRetentionEvictions', () => {
  it('defaults to the same four renderers both hosts already kept', () => {
    expect(BROWSER_RETENTION_LIMIT).toBe(4)
  })

  it('keeps everything within the limit', () => {
    expect(select([used('a', 10_000), used('b', 20_000)], HEADLESS)).toEqual([])
  })

  it('evicts what is ranked beyond the limit', () => {
    expect(
      select([used('newest', 6_000), used('middle', 20_000), used('oldest', 40_000)], HEADLESS)
    ).toEqual(['oldest'])
  })

  it('evicts an idle candidate that is still within the limit', () => {
    expect(select([used('a', 10_000), used('stale', 90_000)], HEADLESS)).toEqual(['stale'])
  })

  it('never evicts inside the grace window, even beyond the limit', () => {
    const fresh = [used('a', 100), used('b', 200), used('c', 300), used('d', 400)]
    expect(select(fresh, HEADLESS)).toEqual([])
  })

  it('never evicts a pinned candidate, so the limit can be exceeded', () => {
    // Two pinned pages ranked beyond the limit hold their renderers rather than
    // interrupting the download/stream that pinned them.
    const candidates = [used('a', 10_000), used('b', 20_000), used('c', 30_000), used('d', 40_000)]
    expect(select(candidates, HEADLESS, ['c', 'd'])).toEqual([])
  })

  it('consults isPinned only for candidates it would otherwise evict', () => {
    const asked: string[] = []
    selectBrowserRetentionEvictions({
      candidates: [used('a', 10_000), used('b', 20_000), used('c', 30_000)],
      isPinned: (id) => {
        asked.push(id)
        return false
      },
      now: NOW,
      budget: HEADLESS
    })
    expect(asked).toEqual(['c'])
  })

  it('respects the caller-supplied order rather than re-sorting', () => {
    // The caller owns LRU ranking; a host with no timestamps ranks by activation.
    expect(
      select([used('oldest', 40_000), used('newest', 6_000), used('mid', 20_000)], HEADLESS)
    ).toEqual(['mid'])
  })

  it('ranks timestamp-free candidates by position alone', () => {
    const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    expect(select(candidates, DESKTOP)).toEqual(['c', 'd'])
  })

  it('never evicts a timestamp-free candidate by clock', () => {
    expect(select([{ id: 'a' }, { id: 'b' }], DESKTOP)).toEqual([])
  })

  it('evicts nothing when both rules are disabled', () => {
    expect(
      select([used('a', 10_000_000), used('b', 10_000_000)], {
        limit: Number.MAX_SAFE_INTEGER,
        idleMs: Number.POSITIVE_INFINITY,
        graceMs: 0
      })
    ).toEqual([])
  })
})
