import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { getTerminalMountedWorktreeSnapshot } from './terminal-mounted-worktrees'

const worktree = (input: Partial<Worktree> & Pick<Worktree, 'id' | 'path'>): Worktree => ({
  id: input.id,
  path: input.path,
  repoId: input.repoId ?? 'repo-1',
  displayName: input.displayName ?? input.id,
  comment: input.comment ?? '',
  branch: input.branch ?? 'main',
  head: input.head ?? 'abc123',
  isBare: input.isBare ?? false,
  isMainWorktree: input.isMainWorktree ?? false,
  linkedIssue: input.linkedIssue ?? null,
  linkedPR: input.linkedPR ?? null,
  linkedLinearIssue: input.linkedLinearIssue ?? null,
  isArchived: input.isArchived ?? false,
  isUnread: input.isUnread ?? false,
  isPinned: input.isPinned ?? false,
  sortOrder: input.sortOrder ?? 0,
  lastActivityAt: input.lastActivityAt ?? 0
})

describe('getTerminalMountedWorktreeSnapshot', () => {
  it('preserves the snapshot when unrelated worktree metadata changes', () => {
    const mountedIds = new Set(['wt-active'])
    const first = getTerminalMountedWorktreeSnapshot(
      {
        'repo-1': [
          worktree({ id: 'wt-active', path: '/repo/active', linkedIssue: 1 }),
          worktree({ id: 'wt-other', path: '/repo/other', displayName: 'Other' })
        ]
      },
      mountedIds
    )
    const second = getTerminalMountedWorktreeSnapshot(
      {
        'repo-1': [
          worktree({ id: 'wt-active', path: '/repo/active', linkedIssue: 2 }),
          worktree({ id: 'wt-other', path: '/repo/other', displayName: 'Renamed' })
        ]
      },
      mountedIds
    )

    expect(second).toBe(first)
    expect(second.mountedWorktrees).toEqual([{ id: 'wt-active', path: '/repo/active' }])
  })

  it('returns a new snapshot when a mounted worktree path changes', () => {
    const mountedIds = new Set(['wt-active'])
    const first = getTerminalMountedWorktreeSnapshot(
      { 'repo-1': [worktree({ id: 'wt-active', path: '/repo/active' })] },
      mountedIds
    )
    const second = getTerminalMountedWorktreeSnapshot(
      { 'repo-1': [worktree({ id: 'wt-active', path: '/repo/moved' })] },
      mountedIds
    )

    expect(second).not.toBe(first)
    expect(second.mountedWorktrees).toEqual([{ id: 'wt-active', path: '/repo/moved' }])
  })

  it('preserves the snapshot when an unmounted worktree path changes', () => {
    const mountedIds = new Set(['wt-active'])
    const first = getTerminalMountedWorktreeSnapshot(
      {
        'repo-1': [
          worktree({ id: 'wt-active', path: '/repo/active' }),
          worktree({ id: 'wt-hidden', path: '/repo/hidden-a' })
        ]
      },
      mountedIds
    )
    const second = getTerminalMountedWorktreeSnapshot(
      {
        'repo-1': [
          worktree({ id: 'wt-active', path: '/repo/active' }),
          worktree({ id: 'wt-hidden', path: '/repo/hidden-b' })
        ]
      },
      mountedIds
    )

    expect(second).toBe(first)
  })

  it('updates mounted worktrees when the mounted id set changes', () => {
    const first = getTerminalMountedWorktreeSnapshot(
      {
        'repo-1': [
          worktree({ id: 'wt-active', path: '/repo/active' }),
          worktree({ id: 'wt-mounted', path: '/repo/mounted' })
        ]
      },
      new Set(['wt-active'])
    )
    const second = getTerminalMountedWorktreeSnapshot(
      {
        'repo-1': [
          worktree({ id: 'wt-active', path: '/repo/active' }),
          worktree({ id: 'wt-mounted', path: '/repo/mounted' })
        ]
      },
      new Set(['wt-active', 'wt-mounted'])
    )

    expect(second).not.toBe(first)
    expect(second.mountedWorktrees.map((item) => item.id)).toEqual(['wt-active', 'wt-mounted'])
  })
})
