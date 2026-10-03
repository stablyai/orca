import { describe, expect, it } from 'vitest'
import { getUnreadBadgeCount, type UnreadBadgeWorktree } from './unread-badge-count'

function worktree(
  id: string,
  isUnread: boolean,
  overrides: Partial<UnreadBadgeWorktree> = {}
): UnreadBadgeWorktree {
  return { id, isUnread, isArchived: false, ...overrides }
}

describe('getUnreadBadgeCount', () => {
  it('counts unread worktrees', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true), worktree('wt-2', false)] },
        folderWorkspaces: []
      })
    ).toBe(1)
  })

  it('skips archived worktrees, which the sidebar never shows', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true, { isArchived: true })] },
        folderWorkspaces: []
      })
    ).toBe(0)
  })

  it('counts one worktree id on two hosts as the two sidebar rows it is', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: {
          repo: [
            worktree('wt-1', true, { hostId: 'local' }),
            worktree('wt-1', true, { hostId: 'ssh:remote' })
          ]
        },
        folderWorkspaces: []
      })
    ).toBe(2)
  })

  it('counts a row repeated across repo buckets once', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: {
          'repo-a': [worktree('wt-1', true, { hostId: 'local' })],
          'repo-b': [worktree('wt-1', true, { hostId: 'local' })]
        },
        folderWorkspaces: []
      })
    ).toBe(1)
  })

  it('counts unread folder workspaces alongside worktrees', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true)] },
        folderWorkspaces: [{ isUnread: true }, { isUnread: false }]
      })
    ).toBe(2)
  })
})
