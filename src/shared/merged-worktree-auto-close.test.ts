import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES,
  DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS,
  MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES,
  decideMergedWorktreeAutoClose,
  resolveMergedWorktreeAutoCloseGraceMs,
  type MergedWorktreeAutoCloseEvidence,
  type MergedWorktreeAutoCloseRepoContext,
  type MergedWorktreeAutoCloseSubject
} from './merged-worktree-auto-close'

const NOW = 1_800_000_000_000

const LOCAL_GIT_REPO: MergedWorktreeAutoCloseRepoContext = {
  isFolderRepo: false,
  isRemoteRepo: false
}

const LANDED: MergedWorktreeAutoCloseEvidence = { merged: true, clean: true, published: true }

function worktree(
  overrides: Partial<MergedWorktreeAutoCloseSubject> = {}
): MergedWorktreeAutoCloseSubject {
  return {
    id: 'repo-1::/workspaces/feature',
    repoId: 'repo-1',
    path: '/workspaces/feature',
    branch: 'refs/heads/feature',
    isMainWorktree: false,
    isPinned: false,
    createdAt: NOW - DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS - 1,
    ...overrides
  }
}

describe('decideMergedWorktreeAutoClose', () => {
  it('closes a published, merged, clean workspace and reports its short branch', () => {
    expect(decideMergedWorktreeAutoClose(worktree(), LOCAL_GIT_REPO, LANDED, NOW)).toEqual({
      worktreeId: 'repo-1::/workspaces/feature',
      repoId: 'repo-1',
      path: '/workspaces/feature',
      branch: 'feature',
      action: 'close'
    })
  })

  it('keeps a workspace whose branch is not merged', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree(),
      LOCAL_GIT_REPO,
      { ...LANDED, merged: false },
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'not-merged' })
  })

  it('keeps a merged workspace that has uncommitted or untracked changes', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree(),
      LOCAL_GIT_REPO,
      { ...LANDED, clean: false },
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'dirty-files' })
  })

  it('never closes the primary checkout even when it reads as merged and clean', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree({ isMainWorktree: true, branch: 'refs/heads/main' }),
      LOCAL_GIT_REPO,
      LANDED,
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'main-worktree' })
  })

  it('keeps a pinned workspace', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree({ isPinned: true }),
      LOCAL_GIT_REPO,
      LANDED,
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'pinned' })
  })

  it('keeps folder and SSH workspaces, which have no local merge proof', () => {
    expect(
      decideMergedWorktreeAutoClose(
        worktree(),
        { isFolderRepo: true, isRemoteRepo: false },
        LANDED,
        NOW
      )
    ).toMatchObject({ action: 'skip', reason: 'folder-repo' })
    expect(
      decideMergedWorktreeAutoClose(
        worktree(),
        { isFolderRepo: false, isRemoteRepo: true },
        LANDED,
        NOW
      )
    ).toMatchObject({ action: 'skip', reason: 'remote-host' })
  })

  it('keeps a detached-HEAD workspace', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree({ branch: '' }),
      LOCAL_GIT_REPO,
      LANDED,
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'detached-head' })
  })

  it('keeps a workspace created inside the default grace window', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree({ createdAt: NOW - DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS + 1 }),
      LOCAL_GIT_REPO,
      LANDED,
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'recently-created' })
  })

  it('closes a just-created landed workspace when the grace window is zero', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree({ createdAt: NOW }),
      LOCAL_GIT_REPO,
      LANDED,
      NOW,
      0
    )

    expect(decision).toMatchObject({ action: 'close' })
  })

  it('keeps a workspace still inside a configured grace window', () => {
    const graceMs = 60_000
    const decision = decideMergedWorktreeAutoClose(
      worktree({ createdAt: NOW - graceMs + 1 }),
      LOCAL_GIT_REPO,
      LANDED,
      NOW,
      graceMs
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'recently-created' })
  })

  it('keeps a branch that was never published, which is how a no-commit workspace reads', () => {
    const decision = decideMergedWorktreeAutoClose(
      worktree(),
      LOCAL_GIT_REPO,
      { merged: true, clean: true, published: false },
      NOW
    )

    expect(decision).toMatchObject({ action: 'skip', reason: 'never-published' })
  })

  it('keeps a workspace when Git could not prove the merge or read the status', () => {
    expect(
      decideMergedWorktreeAutoClose(worktree(), LOCAL_GIT_REPO, { ...LANDED, merged: null }, NOW)
    ).toMatchObject({ action: 'skip', reason: 'merge-check-failed' })
    expect(
      decideMergedWorktreeAutoClose(worktree(), LOCAL_GIT_REPO, { ...LANDED, clean: null }, NOW)
    ).toMatchObject({ action: 'skip', reason: 'status-check-failed' })
  })
})

describe('resolveMergedWorktreeAutoCloseGraceMs', () => {
  it('falls back to the default when the profile never wrote the setting', () => {
    expect(resolveMergedWorktreeAutoCloseGraceMs(undefined)).toBe(
      DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS
    )
    expect(DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES).toBe(10)
  })

  it('turns zero minutes into no grace at all', () => {
    expect(resolveMergedWorktreeAutoCloseGraceMs(0)).toBe(0)
  })

  it('converts configured minutes to milliseconds', () => {
    expect(resolveMergedWorktreeAutoCloseGraceMs(3)).toBe(3 * 60_000)
  })

  it('clamps a value outside the range the control can produce', () => {
    expect(resolveMergedWorktreeAutoCloseGraceMs(-5)).toBe(0)
    expect(
      resolveMergedWorktreeAutoCloseGraceMs(MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES + 1)
    ).toBe(MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES * 60_000)
  })

  it('falls back to the default for a value that is not a finite number', () => {
    expect(resolveMergedWorktreeAutoCloseGraceMs(Number.NaN)).toBe(
      DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS
    )
  })
})
