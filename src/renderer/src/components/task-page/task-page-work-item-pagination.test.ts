import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { accumulateWorkItemPages } from './task-page-work-item-pagination'

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

// Use distinct descending timestamps so the last fixture row is the oldest.
function run(r: string, from: number, to: number): GitHubWorkItem[] {
  const out: GitHubWorkItem[] = []
  for (let n = from; n <= to; n += 1) {
    const ts = `2026-01-01T00:00:${String(1000 - n).padStart(4, '0')}Z`
    out.push(item(r, `issue:${n}`, ts))
  }
  return out
}

describe('accumulateWorkItemPages', () => {
  it('backfills across fetches so a deduped page stays full and the tail stays reachable', async () => {
    // Boundary dedup leaves two fresh rows; backfill the third so count-derived pages cannot strand tail items.
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

  it('stops (flushing progress) when a full page yields nothing new', async () => {
    const existing = [run('r', 1, 3)]
    const cursor0 = run('r', 1, 3).at(-1)!.updatedAt
    // Repeated same-timestamp rows stall the cursor; flush the buffered fresh rows.
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
    expect(result.newPages).toEqual([run('r', 4, 5)])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('recovers leftover rows discarded at the target boundary on the next call', async () => {
    const pageSize = 3
    // Rows past the requested display page are discarded until the next advance.
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

    // Re-fetch the discarded tail from the inclusive boundary without duplicating the displayed page.
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
})
