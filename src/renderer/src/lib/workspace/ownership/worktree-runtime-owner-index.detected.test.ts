import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { applyDetectedWorktreeUpdates } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { replaceDetectedWorktreeListing } from '@/store/slices/worktrees/listing/detected-worktree-publication'
import type { DetectedWorktreeListResult } from '../../../../../shared/worktree/types'
import { describe, expect, it } from 'vitest'

import {
  findIndexedDetectedWorktrees,
  findIndexedDetectedWorktreeRows,
  hasIndexedDetectedWorktree
} from './worktree-runtime-owner-index'

describe('detected worktree index', () => {
  it('keeps original duplicate order and physical-host filtering through addressed metadata, host and inventory changes', () => {
    const unstamped = {
      ...makeWorktree({ id: 'repo::wt', repoId: 'repo' }),
      ownership: 'external' as const,
      selectedCheckout: false,
      visible: false
    }
    const local = { ...unstamped, hostId: 'local' as const }
    const ssh = {
      ...unstamped,
      hostId: 'ssh:physical' as const,
      runtimeOwnerEnvironmentId: 'paired'
    }
    const before: Record<string, DetectedWorktreeListResult> = {
      first: {
        repoId: 'repo',
        authoritative: true,
        source: 'git',
        worktrees: [unstamped, local, local]
      },
      second: { repoId: 'repo', authoritative: true, source: 'git', worktrees: [ssh] }
    }
    expect(findIndexedDetectedWorktreeRows(before, 'repo::wt')).toEqual([
      unstamped,
      local,
      local,
      ssh
    ])
    expect(findIndexedDetectedWorktrees(before, 'repo::wt', 'local')).toEqual([local, local])
    expect(findIndexedDetectedWorktrees(before, 'repo::wt', 'runtime:paired')).toEqual([])
    const renamed = applyDetectedWorktreeUpdates(
      before,
      'repo::wt',
      { displayName: 'Current original' },
      'local'
    )
    const originals = findIndexedDetectedWorktreeRows(renamed, 'repo::wt')
    expect(originals[0]).toBe(renamed.first.worktrees[0])
    expect(originals[0].hostId).toBeUndefined()
    expect(originals[1]).toBe(renamed.first.worktrees[1])
    expect(originals[2]).toBe(renamed.first.worktrees[2])
    expect(originals[3]).toBe(ssh)
    expect(originals[1].displayName).toBe('Current original')
    const moved = replaceDetectedWorktreeListing(renamed, 'first', {
      ...renamed.first,
      worktrees: [
        renamed.first.worktrees[0],
        { ...renamed.first.worktrees[1], hostId: 'ssh:changed' },
        { ...renamed.first.worktrees[2], hostId: 'ssh:changed' }
      ]
    })
    expect(findIndexedDetectedWorktrees(moved, 'repo::wt', 'local')).toEqual([])
    expect(findIndexedDetectedWorktrees(moved, 'repo::wt', 'ssh:changed')).toEqual([
      moved.first.worktrees[1],
      moved.first.worktrees[2]
    ])
    // Original snapshots must retain their original hits, including an identical duplicate publication.
    expect(findIndexedDetectedWorktrees(before, 'repo::wt', 'local')).toEqual([local, local])
    const reordered = replaceDetectedWorktreeListing(moved, 'first', {
      ...moved.first,
      worktrees: [moved.first.worktrees[2], moved.first.worktrees[0], moved.first.worktrees[1]]
    })
    expect(findIndexedDetectedWorktreeRows(reordered, 'repo::wt')).toEqual([
      moved.first.worktrees[2],
      renamed.first.worktrees[0],
      moved.first.worktrees[1],
      ssh
    ])
    const removed = replaceDetectedWorktreeListing(reordered, 'first', {
      ...reordered.first,
      worktrees: []
    })
    expect(findIndexedDetectedWorktreeRows(removed, 'repo::wt')).toEqual([ssh])
    const republished = { ...removed, second: { ...removed.second, worktrees: [] } }
    expect(findIndexedDetectedWorktreeRows(republished, 'repo::wt')).toEqual([])
  })

  it('re-indexes a new catalog identity instead of serving stale hits', () => {
    const worktree = { id: 'repo::wt', repoId: 'repo' }
    const before = { repo: { worktrees: [worktree] } }
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)

    const afterRemoval = { repo: { worktrees: [] } }
    expect(hasIndexedDetectedWorktree(afterRemoval, 'repo::wt')).toBe(false)

    const afterReadd = { repo: { worktrees: [worktree] } }
    expect(findIndexedDetectedWorktrees(afterReadd, 'repo::wt')).toEqual([worktree])
    // The prior identity keeps its own cached answer; nothing bleeds between snapshots.
    expect(hasIndexedDetectedWorktree(afterRemoval, 'repo::wt')).toBe(false)
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)
  })
})
