import { describe, expect, it } from 'vitest'
import { fenceStartedAt, withDetectedOnlyRows } from './fetched-worktree-color-tag-fence'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { FencedWorktreeMergeArgs } from './worktree-slice-types'

function args(scan: number | undefined, caller: number | undefined): FencedWorktreeMergeArgs {
  return {
    refresh: { startedAt: scan },
    requestStartedAt: caller
  } as unknown as FencedWorktreeMergeArgs
}

describe('fenceStartedAt', () => {
  // Regression: a caller joining an in-flight scan stamped its own, later start, so a write that
  // landed between the scan's start and the join looked older than the fence.
  it('fences on the earlier of the scan start and the caller start', () => {
    expect(fenceStartedAt(args(500, 900))).toBe(500)
    expect(fenceStartedAt(args(900, 500))).toBe(500)
  })

  it('uses whichever is known when only one is', () => {
    expect(fenceStartedAt(args(undefined, 900))).toBe(900)
    expect(fenceStartedAt(args(500, undefined))).toBe(500)
    expect(fenceStartedAt(args(undefined, undefined))).toBeUndefined()
  })
})

describe('withDetectedOnlyRows', () => {
  const row = (hostId: string, extra: Record<string, unknown> = {}): Worktree =>
    ({ id: 'repo::w', hostId, colorTag: null, ...extra }) as unknown as Worktree

  // Regression: deduplication by bare id dropped a detected-only row on host B behind a visible row
  // on host A, so a B refresh lacked the snapshot it needed and reverted B's color.
  it("keeps a detected-only row on another host that shares the visible row's id", () => {
    const merged = withDetectedOnlyRows([row('ssh:a')], [row('ssh:b')])
    expect(merged?.map((worktree) => worktree.hostId)).toEqual(['ssh:a', 'ssh:b'])
  })

  it('drops a detected row that is the same row as a visible one', () => {
    const merged = withDetectedOnlyRows([row('ssh:a')], [row('ssh:a')])
    expect(merged).toHaveLength(1)
  })

  it('returns the visible rows untouched when nothing is detected-only', () => {
    const visible = [row('local')]
    expect(withDetectedOnlyRows(visible, undefined)).toBe(visible)
    expect(withDetectedOnlyRows(visible, [])).toBe(visible)
  })
})
