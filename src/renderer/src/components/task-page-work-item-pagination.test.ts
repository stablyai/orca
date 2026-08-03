import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/types'
import {
  accumulateWorkItemPages,
  applyEmptyPageClamp,
  applyWindowPageLimit,
  buildSelectedReposKey,
  deriveAdvertisedTotalPages,
  getTaskPagePerRepoLimit,
  resolveEmptyPageOutcome,
  taskPageToGitHubApiPage,
  workItemIdentity
} from './task-page-work-item-pagination'

function item(repoId: string, id: string, updatedAt: string): GitHubWorkItem {
  return {
    id,
    type: 'issue',
    number: Number.parseInt(id.split(':')[1] ?? '0', 10),
    title: id,
    state: 'open',
    url: `https://example.test/${id}`,
    labels: [],
    updatedAt,
    author: null,
    repoId
  }
}

// Build a run of issues numbered `from`..`to` (inclusive) with strictly
// decreasing updatedAt, on repo `r`, so `at(-1)` is the oldest.
function run(r: string, from: number, to: number): GitHubWorkItem[] {
  const out: GitHubWorkItem[] = []
  for (let n = from; n <= to; n += 1) {
    // Larger number => newer; encode as a descending timestamp so sort order is
    // unambiguous and distinct.
    const ts = `2026-01-01T00:00:${String(1000 - n).padStart(4, '0')}Z`
    out.push(item(r, `issue:${n}`, ts))
  }
  return out
}

describe('workItemIdentity', () => {
  it('qualifies the bare id with the repo so cross-repo collisions are distinct', () => {
    expect(workItemIdentity(item('repo-a', 'issue:9', 't'))).toBe('repo-a:issue:9')
    expect(workItemIdentity(item('repo-b', 'issue:9', 't'))).not.toBe(
      workItemIdentity(item('repo-a', 'issue:9', 't'))
    )
  })
})

describe('numbered GitHub pagination', () => {
  it('converts zero-indexed task pages to one-indexed API pages', () => {
    expect(taskPageToGitHubApiPage(0)).toBe(1)
    expect(taskPageToGitHubApiPage(1)).toBe(2)
    expect(taskPageToGitHubApiPage(15)).toBe(16)
  })

  it('divides the display budget before per-repo fetches can overflow it', () => {
    expect(getTaskPagePerRepoLimit(1, 36, 100)).toBe(36)
    expect(getTaskPagePerRepoLimit(2, 36, 100)).toBe(36)
    expect(getTaskPagePerRepoLimit(3, 36, 100)).toBe(33)
    expect(getTaskPagePerRepoLimit(90, 36, 100)).toBe(1)
  })
})

describe('resolveEmptyPageOutcome', () => {
  const base = { failedCount: 0, errorTypes: [] as const, countedTotalPages: null }

  it('clamps and reports unreachable when the search window 422 is present', () => {
    expect(
      resolveEmptyPageOutcome({ ...base, target: 33, errorTypes: ['validation_error'] })
    ).toEqual({ reason: 'window-unreachable', clampTotalPagesTo: 33 })
    // A real count is still clamped — the count over-advertising is the bug.
    expect(
      resolveEmptyPageOutcome({
        ...base,
        target: 33,
        errorTypes: ['validation_error'],
        countedTotalPages: 39
      })
    ).toEqual({ reason: 'window-unreachable', clampTotalPagesTo: 33 })
  })

  it('resolves as load-failed when a window 422 coincides with a sibling failure', () => {
    // Repos advance independently; another repo's failure — thrown or on the
    // envelope channel — says nothing about the healthy repos' remaining
    // pages, and the transient failure is the actionable signal.
    expect(
      resolveEmptyPageOutcome({
        ...base,
        target: 5,
        failedCount: 1,
        errorTypes: ['validation_error']
      })
    ).toEqual({ reason: 'load-failed', clampTotalPagesTo: null })
    expect(
      resolveEmptyPageOutcome({
        ...base,
        target: 5,
        errorTypes: ['validation_error', 'permission_denied']
      })
    ).toEqual({ reason: 'load-failed', clampTotalPagesTo: null })
  })

  it('reports a failure without clamping for transient or unclassified errors', () => {
    expect(resolveEmptyPageOutcome({ ...base, target: 5, failedCount: 2 })).toEqual({
      reason: 'load-failed',
      clampTotalPagesTo: null
    })
    for (const type of ['permission_denied', 'not_found', 'rate_limited', 'unknown'] as const) {
      expect(resolveEmptyPageOutcome({ ...base, target: 5, errorTypes: [type] })).toEqual({
        reason: 'load-failed',
        clampTotalPagesTo: null
      })
    }
  })

  it('withdraws the speculative page on clean empty only while the count is unknown', () => {
    expect(resolveEmptyPageOutcome({ ...base, target: 2 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: 2
    })
    // 0 means the count itself failed — treat like unknown.
    expect(resolveEmptyPageOutcome({ ...base, target: 2, countedTotalPages: 0 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: 2
    })
    // A real count must not shrink: the PR list path swallows its own failures
    // into clean-empty results, and clamping would hide healthy pages silently.
    expect(resolveEmptyPageOutcome({ ...base, target: 2, countedTotalPages: 34 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: null
    })
    // Never clamps below one advertised page.
    expect(resolveEmptyPageOutcome({ ...base, target: 0 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: 1
    })
  })
})

describe('applyEmptyPageClamp', () => {
  const clean = { failedCount: 0, errorTypes: [] as const }

  it('keeps a real count that resolved between click and response', () => {
    // The count promise routinely lands mid-flight; the committed value, not
    // the click-time closure, must decide whether end-of-data may clamp.
    expect(applyEmptyPageClamp(33, { ...clean, target: 2 })).toBe(33)
  })

  it('withdraws the speculative page while the count is unknown or failed', () => {
    expect(applyEmptyPageClamp(null, { ...clean, target: 2 })).toBe(2)
    expect(applyEmptyPageClamp(0, { ...clean, target: 2 })).toBe(2)
  })

  it('never touches the count for window or failure outcomes', () => {
    // Window 422 limits live in provenPageLimit (applyWindowPageLimit), not
    // the count slot.
    expect(
      applyEmptyPageClamp(39, { target: 33, failedCount: 0, errorTypes: ['validation_error'] })
    ).toBe(39)
    expect(applyEmptyPageClamp(33, { target: 5, failedCount: 2, errorTypes: [] })).toBe(33)
    expect(applyEmptyPageClamp(null, { target: 5, failedCount: 2, errorTypes: [] })).toBe(null)
  })
})

describe('applyWindowPageLimit', () => {
  it('sets, only lowers, and never goes below one page', () => {
    expect(applyWindowPageLimit(null, 33)).toBe(33)
    expect(applyWindowPageLimit(33, 20)).toBe(20)
    expect(applyWindowPageLimit(20, 33)).toBe(20)
    expect(applyWindowPageLimit(null, 0)).toBe(1)
  })
})

describe('deriveAdvertisedTotalPages', () => {
  it('is order-independent: a count landing after a speculative withdrawal wins', () => {
    // Probe first: end-of-data wrote countedTotalPages=1 (speculative). Count
    // then overwrites with 39 — the bar must show 39, not stay collapsed.
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 1,
        countedTotalPages: 39,
        fallbackTotalPages: 2,
        provenPageLimit: null
      })
    ).toBe(39)
  })

  it('caps a real count with the proven window limit', () => {
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 3,
        countedTotalPages: 39,
        fallbackTotalPages: 4,
        provenPageLimit: 33
      })
    ).toBe(33)
  })

  it('uses the fallback while the count is unknown/failed, still window-capped', () => {
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 1,
        countedTotalPages: null,
        fallbackTotalPages: 2,
        provenPageLimit: null
      })
    ).toBe(2)
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 1,
        countedTotalPages: 0,
        fallbackTotalPages: 5,
        provenPageLimit: 3
      })
    ).toBe(3)
  })

  it('never advertises fewer pages than are loaded', () => {
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 5,
        countedTotalPages: 2,
        fallbackTotalPages: 2,
        provenPageLimit: 2
      })
    ).toBe(5)
  })
})

describe('buildSelectedReposKey', () => {
  const contextFor = (r: { id: string }) => ({ provider: 'github', repoId: r.id })

  it('is stable across fresh arrays with identical contents', () => {
    const a = [{ id: 'r1', path: '/a', connectionId: null, executionHostId: null }]
    const b = [{ ...a[0] }]
    expect(buildSelectedReposKey(a, contextFor)).toBe(buildSelectedReposKey(b, contextFor))
  })

  it('changes when any request-relevant field changes', () => {
    const repo = { id: 'r1', path: '/a', connectionId: null, executionHostId: null }
    const key = buildSelectedReposKey([repo], contextFor)
    expect(buildSelectedReposKey([{ ...repo, executionHostId: 'ssh:host' }], contextFor)).not.toBe(
      key
    )
    expect(buildSelectedReposKey([{ ...repo, path: '/b' }], contextFor)).not.toBe(key)
    expect(
      buildSelectedReposKey([repo], (r) => ({ provider: 'github', repoId: r.id, owner: 'new' }))
    ).not.toBe(key)
  })
})

describe('accumulateWorkItemPages', () => {
  it('drops the re-fetched boundary row that shares the previous page cursor', async () => {
    const boundary = item('r', 'issue:2', '2026-07-02')
    const existing = [[item('r', 'issue:1', '2026-07-03'), boundary]]
    // Inclusive cursor re-returns issue:2 (boundary) then genuinely older rows,
    // enough to fill a full page of size 2 after dedup.
    const fetchPage = vi.fn().mockResolvedValue({
      items: [boundary, item('r', 'issue:3', '2026-07-01'), item('r', 'issue:4', '2026-07-00')]
    })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: '2026-07-02',
      targetPage: 1,
      pageSize: 2,
      fetchPage,
      isCancelled: () => false
    })

    expect(result.cancelled).toBe(false)
    if (result.cancelled) {
      return
    }
    expect(result.newPages).toEqual([
      [item('r', 'issue:3', '2026-07-01'), item('r', 'issue:4', '2026-07-00')]
    ])
    expect(result.loadedPages).toBe(2)
    expect(fetchPage).toHaveBeenCalledWith('2026-07-02')
  })

  it('backfills across fetches so a deduped page stays full and the tail stays reachable', async () => {
    // Regression: pageSize 3. Page 0 = issues 1..3. Inclusive cursor re-fetches
    // the boundary (issue:3), so a naive "one fetch = one page" scheme would emit
    // a 2-item page and the count-derived totalPages would strand the tail.
    const existing = [run('r', 1, 3)]
    const cursor0 = run('r', 1, 3).at(-1)!.updatedAt
    const fetchPage = vi
      .fn()
      // <=cursor0 re-returns issue:3 (boundary) + 4,5 => 2 fresh, not yet a page.
      .mockResolvedValueOnce({ items: run('r', 3, 5) })
      // Backfill fetches again from issue:5's ts and gets 5 (boundary) + 6 => 1 fresh.
      .mockResolvedValueOnce({ items: run('r', 5, 6) })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: cursor0,
      targetPage: 1,
      pageSize: 3,
      fetchPage,
      isCancelled: () => false
    })

    expect(result.cancelled).toBe(false)
    if (result.cancelled) {
      return
    }
    // One uniform full page of the 3 genuinely-new items 4,5,6 — nothing stranded.
    expect(result.newPages).toEqual([run('r', 4, 6)])
    expect(result.loadedPages).toBe(2)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(fetchPage).toHaveBeenNthCalledWith(2, run('r', 3, 5).at(-1)!.updatedAt)
  })

  it('does not confuse same-numbered items from different repos', async () => {
    const existing = [[item('repo-a', 'issue:9', '2026-07-02')]]
    // repo-b's issue:9 is a different item and must survive dedup.
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ items: [item('repo-b', 'issue:9', '2026-07-01')] })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: '2026-07-02',
      targetPage: 1,
      pageSize: 1,
      fetchPage,
      isCancelled: () => false
    })

    expect(result.cancelled).toBe(false)
    if (result.cancelled) {
      return
    }
    expect(result.newPages).toEqual([[item('repo-b', 'issue:9', '2026-07-01')]])
    expect(result.loadedPages).toBe(2)
  })

  it('flushes a short final page when the source is exhausted mid-page', async () => {
    const existing = [run('r', 1, 3)]
    const cursor0 = run('r', 1, 3).at(-1)!.updatedAt
    const fetchPage = vi
      .fn()
      // 2 fresh rows, short of pageSize 3...
      .mockResolvedValueOnce({ items: run('r', 3, 5) })
      // ...then the source is exhausted.
      .mockResolvedValueOnce({ items: [] })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: cursor0,
      targetPage: 1,
      pageSize: 3,
      fetchPage,
      isCancelled: () => false
    })

    expect(result.cancelled).toBe(false)
    if (result.cancelled) {
      return
    }
    // Short final page rather than dropping issues 4,5.
    expect(result.newPages).toEqual([run('r', 4, 5)])
    expect(result.loadedPages).toBe(2)
  })

  it('stops (flushing progress) when a full page yields nothing new', async () => {
    const existing = [run('r', 1, 3)]
    const cursor0 = run('r', 1, 3).at(-1)!.updatedAt
    // First fetch adds issues 4,5 (2 fresh); second fetch re-returns only
    // already-seen rows (a >pageSize same-timestamp run) — no forward progress.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: run('r', 3, 5) })
      .mockResolvedValueOnce({ items: run('r', 4, 5) })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: cursor0,
      targetPage: 5,
      pageSize: 3,
      fetchPage,
      isCancelled: () => false
    })

    expect(result.cancelled).toBe(false)
    if (result.cancelled) {
      return
    }
    // The 2 buffered fresh rows are flushed rather than lost.
    expect(result.newPages).toEqual([run('r', 4, 5)])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('chains full pages until the target page is reached', async () => {
    const existing = [run('r', 1, 2)]
    const cursor0 = run('r', 1, 2).at(-1)!.updatedAt
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: run('r', 2, 4) }) // boundary 2 + 3,4
      .mockResolvedValueOnce({ items: run('r', 4, 6) }) // boundary 4 + 5,6

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: cursor0,
      targetPage: 2,
      pageSize: 2,
      fetchPage,
      isCancelled: () => false
    })

    expect(result.cancelled).toBe(false)
    if (result.cancelled) {
      return
    }
    expect(result.newPages).toEqual([run('r', 3, 4), run('r', 5, 6)])
    expect(result.loadedPages).toBe(3)
  })

  it('stops at an empty page (source exhausted) with no buffered rows', async () => {
    const existing = [[item('r', 'issue:1', '2026-07-02')]]
    const fetchPage = vi.fn().mockResolvedValue({ items: [] })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: '2026-07-02',
      targetPage: 3,
      pageSize: 3,
      fetchPage,
      isCancelled: () => false
    })

    expect(result).toEqual({ cancelled: false, newPages: [], loadedPages: 1 })
  })

  it('recovers leftover rows discarded at the target boundary on the next call', async () => {
    const pageSize = 3
    // Call 1: page0 = 1..3, target page 1. The fetch returns more than one
    // page of fresh rows; issue 7 is past the emitted page and gets discarded
    // (it belongs to page 2, which the user hasn't requested yet).
    const existing1 = [run('r', 1, 3)]
    const fetch1 = vi.fn().mockResolvedValueOnce({ items: run('r', 3, 7) }) // boundary 3 + 4,5,6,7
    const call1 = await accumulateWorkItemPages({
      existingPages: existing1,
      initialCursor: run('r', 1, 3).at(-1)!.updatedAt,
      targetPage: 1,
      pageSize,
      fetchPage: fetch1,
      isCancelled: () => false
    })
    expect(call1.cancelled).toBe(false)
    if (call1.cancelled) {
      return
    }
    expect(call1.newPages).toEqual([run('r', 4, 6)]) // 7 discarded

    // Call 2: page1 is now on screen. The inclusive cursor re-fetches the
    // boundary (6, deduped) plus the discarded 7 and beyond — 7 must reappear
    // exactly once, in order, with no duplicate of 4..6.
    const call2 = await accumulateWorkItemPages({
      existingPages: [...existing1, ...call1.newPages],
      initialCursor: call1.newPages.at(-1)!.at(-1)!.updatedAt, // ts(6)
      targetPage: 2,
      pageSize,
      fetchPage: vi.fn().mockResolvedValueOnce({ items: run('r', 6, 9) }), // boundary 6 + 7,8,9
      isCancelled: () => false
    })
    expect(call2.cancelled).toBe(false)
    if (call2.cancelled) {
      return
    }
    expect(call2.newPages).toEqual([run('r', 7, 9)]) // 7 recovered, deduped, in order
  })

  it('reports cancellation and discards fetched pages when superseded', async () => {
    const existing = [[item('r', 'issue:1', '2026-07-02')]]
    const fetchPage = vi.fn().mockResolvedValue({ items: [item('r', 'issue:2', '2026-07-01')] })

    const result = await accumulateWorkItemPages({
      existingPages: existing,
      initialCursor: '2026-07-02',
      targetPage: 1,
      pageSize: 1,
      fetchPage,
      isCancelled: () => true
    })

    expect(result).toEqual({ cancelled: true })
  })
})
