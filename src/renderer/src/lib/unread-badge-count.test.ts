import { describe, expect, it } from 'vitest'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getUnreadBadgeCount, type UnreadBadgeCountSources } from './unread-badge-count'

function count(overrides: Partial<UnreadBadgeCountSources>): number {
  return getUnreadBadgeCount({
    worktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspaceHasUnread: false,
    ...overrides
  })
}

describe('getUnreadBadgeCount', () => {
  it('counts unread worktrees', () => {
    expect(
      count({
        worktreesByRepo: {
          repo: [
            makeWorktree({ id: 'wt-1', repoId: 'repo', isUnread: true }),
            makeWorktree({ id: 'wt-2', repoId: 'repo' })
          ]
        }
      })
    ).toBe(1)
    expect(
      count({
        worktreesByRepo: {
          repo: [
            makeWorktree({ id: 'wt-1', repoId: 'repo', isUnread: true }),
            makeWorktree({ id: 'wt-2', repoId: 'repo', isUnread: true })
          ]
        }
      })
    ).toBe(2)
  })

  it('dedupes one worktree id listed under two repo buckets', () => {
    expect(
      count({
        worktreesByRepo: {
          'repo-a': [makeWorktree({ id: 'shared', repoId: 'repo-a', isUnread: true })],
          'repo-b': [makeWorktree({ id: 'shared', repoId: 'repo-b', isUnread: true })]
        }
      })
    ).toBe(1)
  })

  it('does not count archived worktrees or folders, which the sidebar never renders', () => {
    expect(
      count({
        worktreesByRepo: {
          repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', isUnread: true, isArchived: true })]
        },
        folderWorkspaces: [makeFolderWorkspace({ id: 'f-1', isUnread: true, isArchived: true })]
      })
    ).toBe(0)
  })

  it('counts unread folder workspaces by their workspace key', () => {
    expect(count({ folderWorkspaces: [makeFolderWorkspace({ id: 'f-1', isUnread: true })] })).toBe(
      1
    )
    // A folder whose raw id equals a worktree id is still a different workspace.
    expect(
      count({
        worktreesByRepo: {
          repo: [makeWorktree({ id: 'f-1', repoId: 'repo', isUnread: true })]
        },
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'f-1', isUnread: true }),
          makeFolderWorkspace({ id: 'f-2' })
        ]
      })
    ).toBe(2)
  })

  it('counts the floating workspace once', () => {
    expect(count({ floatingWorkspaceHasUnread: true })).toBe(1)
    expect(
      count({
        worktreesByRepo: {
          repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', isUnread: true })]
        },
        floatingWorkspaceHasUnread: true
      })
    ).toBe(2)
  })
})
