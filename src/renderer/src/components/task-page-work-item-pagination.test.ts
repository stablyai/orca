import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/types'
import { accumulateWorkItemPages, workItemIdentity } from './task-page-work-item-pagination'

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
