import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { describe, expect, it } from 'vitest'

import {
  createWorktreeCatalogQueryOwner,
  findFirstIndexedWorktree,
  findIndexedWorktreeOwnerForHost,
  findIndexedWorktrees,
  resolveIndexedWorktreeOwner,
  findIndexedDetectedWorktrees,
  hasIndexedDetectedWorktree
} from './worktree-runtime-owner-index'

describe('detected worktree index', () => {
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

describe('accepted catalog snapshots', () => {
  it('refreshes typed rows and duplicate precedence without changing retained answers', () => {
    const early = {
      id: 'repo::wt',
      repoId: 'repo',
      hostId: 'ssh:builder' as const,
      runtimeOwnerEnvironmentId: 'server',
      title: 'early'
    }
    const late = { ...early, title: 'late' }
    const before = { '10': [late], '2': [early] }
    const owner = createWorktreeCatalogQueryOwner()
    owner.known.ensure(before)
    const held = resolveIndexedWorktreeOwner(before, 'repo::wt')
    const heldRows = findIndexedWorktrees(before, 'repo::wt')
    const renamed = { ...early, title: 'renamed' }
    const next = replaceRecordEntries(before, [['2', [renamed]]])
    owner.known.accept(next, before)
    expect(findFirstIndexedWorktree(next, 'repo::wt')?.title).toBe('renamed')
    expect(findIndexedWorktreeOwnerForHost(next, 'repo::wt', 'runtime:server')).toBe(renamed)
    expect(findIndexedWorktrees(next, 'repo::wt', 'runtime:server')).toEqual([])
    expect(findIndexedWorktrees(next, 'repo::wt', 'ssh:builder')).toEqual([renamed, late])
    expect(held).toMatchObject({ kind: 'resolved', owner: early })
    expect(heldRows).toEqual([early, late])
    const removed = replaceRecordEntries<(typeof early)[]>(next, [['2', null]])
    owner.known.accept(removed, next)
    expect(findFirstIndexedWorktree(removed, 'repo::wt')?.title).toBe('late')
    expect(findFirstIndexedWorktree(before, 'repo::wt')?.title).toBe('early')
    expect(findFirstIndexedWorktree(removed, 'repo::wt')?.title).toBe('late')
  })

  it('keeps provisional and diverging stores separate when their initial source is shared', () => {
    const row: { id: string; repoId: string; hostId: ExecutionHostId } = {
      id: 'repo::wt',
      repoId: 'repo',
      hostId: 'runtime:a'
    }
    const before = { repo: { worktrees: [row] } }
    const a = createWorktreeCatalogQueryOwner(),
      b = createWorktreeCatalogQueryOwner()
    a.detected.ensure(before)
    b.detected.ensure(before)
    const proposed = replaceRecordEntries(before, [['repo', { worktrees: [] }]])
    expect(hasIndexedDetectedWorktree(proposed, 'repo::wt')).toBe(false)
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)
    a.detected.accept(proposed, before)
    const branch = replaceRecordEntries(before, [
      ['repo', { worktrees: [{ ...row, hostId: 'runtime:b' as const }] }]
    ])
    b.detected.accept(branch, before)
    expect(findIndexedDetectedWorktrees(branch, 'repo::wt')).toEqual([
      { id: 'repo::wt', repoId: 'repo', hostId: 'runtime:b' }
    ])
    expect(findIndexedDetectedWorktrees(before, 'repo::wt')).toEqual([row])
    expect(findIndexedDetectedWorktrees(proposed, 'repo::wt')).toEqual([])
  })
})
