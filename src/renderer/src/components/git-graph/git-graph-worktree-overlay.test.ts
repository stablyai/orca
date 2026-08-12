import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { buildGitGraphWorktreeOverlay } from './git-graph-worktree-overlay'

function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'branch'>): Worktree {
  return {
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: `/tmp/${overrides.id}`,
    head: 'a'.repeat(40),
    isBare: false,
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

describe('buildGitGraphWorktreeOverlay', () => {
  it('keys entries by full branch ref and carries display metadata', () => {
    const overlay = buildGitGraphWorktreeOverlay(
      [
        worktree({
          id: 'repo-1::/tmp/feature',
          branch: 'refs/heads/feature',
          displayName: 'Feature work',
          workspaceStatus: 'in-progress'
        })
      ],
      null
    )

    expect(overlay.get('refs/heads/feature')).toEqual({
      worktreeId: 'repo-1::/tmp/feature',
      displayName: 'Feature work',
      workspaceStatus: 'in-progress',
      isActiveWorkspace: false
    })
  })

  it('marks the active workspace and omits missing workspaceStatus', () => {
    const overlay = buildGitGraphWorktreeOverlay(
      [worktree({ id: 'repo-1::/tmp/main', branch: 'refs/heads/main' })],
      'repo-1::/tmp/main'
    )

    const entry = overlay.get('refs/heads/main')
    expect(entry?.isActiveWorkspace).toBe(true)
    expect(entry && 'workspaceStatus' in entry).toBe(false)
  })

  it('skips detached and archived worktrees', () => {
    const overlay = buildGitGraphWorktreeOverlay(
      [
        worktree({ id: 'repo-1::/tmp/detached', branch: '' }),
        worktree({ id: 'repo-1::/tmp/archived', branch: 'refs/heads/old', isArchived: true })
      ],
      null
    )

    expect(overlay.size).toBe(0)
  })

  it('keeps the first entry when two worktrees claim one branch', () => {
    const overlay = buildGitGraphWorktreeOverlay(
      [
        worktree({ id: 'repo-1::/tmp/first', branch: 'refs/heads/shared' }),
        worktree({ id: 'repo-1::/tmp/second', branch: 'refs/heads/shared' })
      ],
      null
    )

    expect(overlay.get('refs/heads/shared')?.worktreeId).toBe('repo-1::/tmp/first')
  })
})
