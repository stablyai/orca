import { describe, expect, it } from 'vitest'
import { shouldBeginWorktreeRename } from './WorktreeCard'

describe('shouldBeginWorktreeRename', () => {
  it('matches unscoped legacy rename requests by worktree id', () => {
    expect(shouldBeginWorktreeRename({ worktreeId: 'wt-1' }, 'wt-1', 'all:wt-1')).toBe(true)
  })

  it('matches row-scoped rename requests only on the target row', () => {
    const request = { worktreeId: 'wt-1', rowKey: 'all:wt-1' }

    expect(shouldBeginWorktreeRename(request, 'wt-1', 'all:wt-1')).toBe(true)
    expect(shouldBeginWorktreeRename(request, 'wt-1', 'pinned:wt-1')).toBe(false)
  })
})
