import { describe, expect, it } from 'vitest'
import { getWorktreeMergeReviewMenuMode, hasWorktreeParentLink } from './worktree-context-menu-policy'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

describe('parent picker context menu affordance', () => {
  it('offers unlink for a folder workspace under a bot, keyed by its own id', () => {
    const folder = makeWorktree({
      id: 'folder:notes',
      repoId: 'folder-group:notes',
      path: '/notes'
    })
    const link = {
      childWorkspaceKey: 'folder:notes' as const,
      childInstanceId: null,
      parentWorkspaceKey: 'folder:atlas-home' as const,
      parentInstanceId: null,
      origin: 'orchestration' as const,
      capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
      createdAt: 1
    }
    expect(hasWorktreeParentLink(folder, {}, { 'folder:notes': link })).toBe(true)
  })
})

describe('getWorktreeMergeReviewMenuMode', () => {
  const task = {
    isMultiContext: false,
    isFolderWorkspace: false,
    isRemote: false,
    isMainWorktree: false,
    worktreeBranch: 'refs/heads/feature',
    mainWorktreeBranch: 'refs/heads/main',
    phase: 'idle' as const,
    syncSupported: true
  }

  it('offers sync only on a task worktree with a branch on both sides', () => {
    expect(getWorktreeMergeReviewMenuMode(task)).toBe('sync')
    expect(getWorktreeMergeReviewMenuMode({ ...task, isMainWorktree: true })).toBe('none')
    expect(getWorktreeMergeReviewMenuMode({ ...task, worktreeBranch: '' })).toBe('none')
    expect(getWorktreeMergeReviewMenuMode({ ...task, mainWorktreeBranch: null })).toBe('none')
  })

  it('hides the action for multi-selection, folder workspaces and remote hosts', () => {
    expect(getWorktreeMergeReviewMenuMode({ ...task, isMultiContext: true })).toBe('none')
    expect(getWorktreeMergeReviewMenuMode({ ...task, isFolderWorkspace: true })).toBe('none')
    // Why: the merge-review IPC handlers require a local Git route.
    expect(getWorktreeMergeReviewMenuMode({ ...task, isRemote: true })).toBe('none')
  })

  it('withholds sync where the host cannot snapshot, but still ends a pending review', () => {
    // Why: WSL has no connectionId, so `isRemote` cannot stand in for "sync unsupported".
    expect(getWorktreeMergeReviewMenuMode({ ...task, syncSupported: false })).toBe('none')
    expect(
      getWorktreeMergeReviewMenuMode({ ...task, syncSupported: false, phase: 'pending' })
    ).toBe('pending')
  })

  // Why: a review belongs to the main checkout, so the main row has to offer the
  // way out of it even though it can never start one.
  it('flips to accept/reject on both cards while a review is pending', () => {
    const pending = { ...task, phase: 'pending' as const }
    expect(getWorktreeMergeReviewMenuMode(pending)).toBe('pending')
    expect(getWorktreeMergeReviewMenuMode({ ...pending, isMainWorktree: true })).toBe('pending')
    expect(getWorktreeMergeReviewMenuMode({ ...pending, worktreeBranch: '' })).toBe('pending')
    // A detached main checkout has no branch to accept into.
    expect(getWorktreeMergeReviewMenuMode({ ...pending, mainWorktreeBranch: null })).toBe('none')
  })
})
