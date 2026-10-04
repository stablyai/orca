import { describe, expect, it } from 'vitest'
import { isSleepingSweepExemptWorkspace } from './sidebar/visible-worktrees'
import type { Worktree } from '../../../shared/worktree/types'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-main',
    repoId: 'repo1',
    path: '/tmp/repo1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('Cmd+J empty-query "Hide sleeping" pass (#8873)', () => {
  it('exempts a project entry point by default and honours an explicit opt-out', () => {
    const main = makeWorktree()

    expect(isSleepingSweepExemptWorkspace(main, undefined)).toBe(true)
    expect(isSleepingSweepExemptWorkspace(main, true)).toBe(true)
    expect(isSleepingSweepExemptWorkspace(main, false)).toBe(false)
  })

  it('never exempts a non-main workspace', () => {
    const feature = makeWorktree({ id: 'wt-feature', isMainWorktree: false })

    expect(isSleepingSweepExemptWorkspace(feature, true)).toBe(false)
    expect(isSleepingSweepExemptWorkspace(feature, undefined)).toBe(false)
  })
})
