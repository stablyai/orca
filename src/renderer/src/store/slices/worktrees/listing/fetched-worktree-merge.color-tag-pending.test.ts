import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'

// Why mock: the fence is fed by real persistence; here the question is only what the merge does
// with its answer. This stand-in reports a write that landed at t=1000 and records every query.
const pendingCalls = vi.hoisted(() => [] as unknown[][])
vi.mock('../metadata/worktree-meta-persist', () => ({
  isColorTagPersistencePending: (
    id: string,
    host: string | undefined,
    fetchStartedAt?: number,
    identityKey?: string
  ) => {
    pendingCalls.push([id, host, fetchStartedAt, identityKey])
    return fetchStartedAt !== undefined && fetchStartedAt <= 1000
  },
  isDisplayNamePersistencePending: () => false
}))

import { preserveConcurrentColorTag } from './fetched-worktree-color-tag-fence'

function worktree(id: string, colorTag: string | null): Worktree {
  return { id, hostId: 'local', colorTag } as unknown as Worktree
}
const anyHost = (): boolean => true
// The snapshot already carries the new color: a fetch that started after the assignment but
// joined a listing captured before it.
const startedAfterWrite = [worktree('a', '#ef4444')]
const current = [worktree('a', '#ef4444')]
const staleIncoming = [worktree('a', null)]

describe('preserveConcurrentColorTag against a write that landed at t=1000', () => {
  // Regression: the fence released the moment the write settled, so this fetch — start snapshot
  // equal to current — judged "nothing changed" and let the stale answer restore the old tag.
  it('keeps the current color for a fetch that started before the write landed', () => {
    const merged = preserveConcurrentColorTag(
      staleIncoming,
      startedAfterWrite,
      current,
      anyHost,
      900
    )
    expect(merged[0]?.colorTag).toBe('#ef4444')
  })

  it('accepts the refreshed value for a fetch that started after the write landed', () => {
    const merged = preserveConcurrentColorTag(
      staleIncoming,
      startedAfterWrite,
      current,
      anyHost,
      1100
    )
    expect(merged[0]?.colorTag).toBeNull()
  })

  it('still honours a plain snapshot-vs-current difference without a start time', () => {
    const merged = preserveConcurrentColorTag(
      staleIncoming,
      [worktree('a', null)],
      current,
      anyHost
    )
    expect(merged[0]?.colorTag).toBe('#ef4444')
  })

  // Regression: a row that entered the store after the refresh began had no start snapshot, and the
  // merge returned the stale listing for it unfenced, so a color assigned meanwhile was erased with
  // no reconcile to bring it back.
  it('keeps the current color for a row missing from the start snapshot while its write is pending', () => {
    const merged = preserveConcurrentColorTag(staleIncoming, [], current, anyHost, 900)
    expect(merged[0]?.colorTag).toBe('#ef4444')
  })

  // Regression: with no catalog bucket at refresh start the merge bailed out before the fence, so a
  // row created and colored during the refresh lost its color to the pre-write listing.
  it('still consults the fence when the refresh started before the repo had a catalog bucket', () => {
    const held = preserveConcurrentColorTag(staleIncoming, undefined, current, anyHost, 900)
    expect(held[0]?.colorTag).toBe('#ef4444')
    const accepted = preserveConcurrentColorTag(staleIncoming, undefined, current, anyHost, 1100)
    expect(accepted[0]?.colorTag).toBeNull()
  })

  it('accepts the refreshed value for such a row once the fetch postdates the landing', () => {
    const merged = preserveConcurrentColorTag(staleIncoming, [], current, anyHost, 1100)
    expect(merged[0]?.colorTag).toBeNull()
  })

  // Regression: two HUBs' rows for one checkout share id and host; the fence has to be asked about
  // exactly the row being merged, or a write for the sibling fences this one.
  it('asks the fence about the current row by its canonical identity', () => {
    pendingCalls.length = 0
    const identified = {
      id: 'a',
      hostId: 'local',
      colorTag: '#ef4444',
      identity: { key: 'k-a' }
    } as unknown as Worktree
    preserveConcurrentColorTag(staleIncoming, startedAfterWrite, [identified], anyHost, 900)
    expect(pendingCalls).toEqual([['a', 'local', 900, 'k-a']])
  })
})
