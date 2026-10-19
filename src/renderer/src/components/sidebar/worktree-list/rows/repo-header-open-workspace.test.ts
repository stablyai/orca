import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { pickRepoHeaderWorkspace } from './repo-header-open-workspace'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'wt',
    isArchived: false,
    isMainWorktree: false,
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

describe('pickRepoHeaderWorkspace', () => {
  it('prefers the primary checkout', () => {
    const picked = pickRepoHeaderWorkspace(
      [
        worktree({ id: 'feature', lastActivityAt: 10 }),
        worktree({ id: 'main', isMainWorktree: true, lastActivityAt: 1 })
      ],
      {}
    )
    expect(picked?.id).toBe('main')
  })

  it('falls back to the most recently active workspace', () => {
    const picked = pickRepoHeaderWorkspace(
      [worktree({ id: 'old', lastActivityAt: 1 }), worktree({ id: 'new', lastActivityAt: 5 })],
      {}
    )
    expect(picked?.id).toBe('new')
  })

  it('skips archived, other-host, and hidden workspaces', () => {
    const picked = pickRepoHeaderWorkspace(
      [
        worktree({ id: 'archived', isMainWorktree: true, isArchived: true }),
        worktree({ id: 'remote', isMainWorktree: true, hostId: 'ssh:dev' as Worktree['hostId'] }),
        worktree({ id: 'hidden', isMainWorktree: true }),
        worktree({ id: 'visible', lastActivityAt: 2 })
      ],
      { hostId: 'local' as Worktree['hostId'], worktreeIds: ['archived', 'remote', 'visible'] }
    )
    expect(picked?.id).toBe('visible')
  })

  it('returns null when the project has no workspace', () => {
    expect(pickRepoHeaderWorkspace([], {})).toBeNull()
  })
})
