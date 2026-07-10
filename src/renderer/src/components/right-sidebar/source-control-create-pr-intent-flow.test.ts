import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createCreatePrIntentRunToken,
  createPrIntentCurrentTargetConflictsWithToken,
  createPrIntentGitStatusMatchesToken,
  createPrIntentRunTokenMatches,
  getCreatePrIntentCommitFailureNoticeMessage,
  getCreatePrIntentStagePaths,
  resolveCreatePrIntentReviewBase,
  resolveCreatePrIntentRemoteStep
} from './source-control-create-pr-intent-flow'
import type { GitStatusEntry } from '../../../../shared/types'

describe('source-control Create PR intent flow helpers', () => {
  it('matches async completions only to the original repo, worktree, path, branch, and base', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123)
    try {
      const token = createCreatePrIntentRunToken({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        branch: 'feature',
        baseRef: 'origin/main'
      })

      expect(token.startedAt).toBe(123)
      expect(createPrIntentRunTokenMatches(token, token)).toBe(true)
      expect(
        createPrIntentRunTokenMatches(token, { ...token, baseRef: 'refs/remotes/origin/main' })
      ).toBe(true)
      expect(createPrIntentRunTokenMatches(token, { ...token, branch: 'other' })).toBe(false)
      expect(createPrIntentRunTokenMatches(token, { ...token, worktreeId: 'wt-2' })).toBe(false)
      expect(createPrIntentRunTokenMatches(token, { ...token, baseRef: 'upstream/main' })).toBe(
        false
      )
    } finally {
      now.mockRestore()
    }
  })

  it('matches strict git status snapshots to the original branch', () => {
    const token = createCreatePrIntentRunToken({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      branch: 'feature/pr'
    })

    expect(createPrIntentGitStatusMatchesToken(token, { branch: 'refs/heads/feature/pr' })).toBe(
      true
    )
    expect(createPrIntentGitStatusMatchesToken(token, { branch: 'feature/pr' })).toBe(true)
    expect(createPrIntentGitStatusMatchesToken(token, { branch: 'refs/heads/other' })).toBe(false)
    expect(createPrIntentGitStatusMatchesToken(token, { branch: null })).toBe(false)
  })

  it('does not treat navigating to another worktree as an intent conflict', () => {
    const wt1Path = join(sep, 'repo', 'wt-1')
    const wt2Path = join(sep, 'repo', 'wt-2')

    const token = createCreatePrIntentRunToken({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath: wt1Path,
      branch: 'feature/pr'
    })

    expect(
      createPrIntentCurrentTargetConflictsWithToken(token, {
        repoId: 'repo-1',
        worktreeId: 'wt-2',
        worktreePath: wt2Path,
        branch: 'other'
      })
    ).toBe(false)

    expect(
      createPrIntentCurrentTargetConflictsWithToken(token, {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        worktreePath: wt1Path,
        branch: 'other'
      })
    ).toBe(true)
  })

  it('treats same-worktree base changes as intent conflicts', () => {
    const worktreePath = join(sep, 'repo', 'wt-1')
    const token = createCreatePrIntentRunToken({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath,
      branch: 'feature/pr',
      baseRef: 'refs/remotes/origin/main'
    })

    expect(
      createPrIntentCurrentTargetConflictsWithToken(token, {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        worktreePath,
        branch: 'feature/pr',
        baseRef: 'remotes/origin/main'
      })
    ).toBe(false)

    expect(
      createPrIntentCurrentTargetConflictsWithToken(token, {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        worktreePath,
        branch: 'feature/pr',
        baseRef: 'upstream/main'
      })
    ).toBe(true)

    expect(
      createPrIntentCurrentTargetConflictsWithToken(token, {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        worktreePath,
        branch: 'feature/pr',
        baseRef: 'origin/release'
      })
    ).toBe(true)
  })

  it('stages only safe unstaged and untracked paths', () => {
    const unresolved = {
      path: 'conflicted.ts',
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    } satisfies GitStatusEntry

    expect(
      getCreatePrIntentStagePaths({
        unstaged: [{ path: 'safe.ts', status: 'modified', area: 'unstaged' }, unresolved],
        untracked: [{ path: 'new.ts', status: 'untracked', area: 'untracked' }]
      })
    ).toEqual(['safe.ts', 'new.ts'])
  })

  it('prefers the current compare base over stale eligibility defaults', () => {
    expect(
      resolveCreatePrIntentReviewBase({
        currentBaseRef: 'refs/remotes/origin/release',
        eligibilityDefaultBaseRef: 'refs/remotes/origin/main',
        composerBaseRef: 'main'
      })
    ).toBe('release')

    expect(
      resolveCreatePrIntentReviewBase({
        currentBaseRef: null,
        eligibilityDefaultBaseRef: 'refs/remotes/upstream/develop',
        composerBaseRef: 'main'
      })
    ).toBe('develop')
  })

  it('resolves safe remote steps for publish, push, and patch-equivalent force-push', () => {
    expect(
      resolveCreatePrIntentRemoteStep({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 2,
        hasCurrentBranch: true,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'no_upstream',
          nextAction: 'publish'
        }
      })
    ).toBe('publish')

    expect(
      resolveCreatePrIntentRemoteStep({
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
        hasCurrentBranch: true,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_push',
          nextAction: 'push'
        }
      })
    ).toBe('push')

    expect(
      resolveCreatePrIntentRemoteStep({
        upstreamStatus: {
          hasUpstream: true,
          ahead: 3,
          behind: 2,
          behindCommitsArePatchEquivalent: true
        },
        branchCommitsAhead: 3,
        hasCurrentBranch: true,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_sync',
          nextAction: 'sync'
        }
      })
    ).toBe('force_push')
  })

  it('blocks ordinary diverged branches and unpublished branches without commits', () => {
    expect(
      resolveCreatePrIntentRemoteStep({
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 1 },
        hasCurrentBranch: true,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_sync',
          nextAction: 'sync'
        }
      })
    ).toBe('blocked')

    expect(
      resolveCreatePrIntentRemoteStep({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 0,
        hasCurrentBranch: true,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'no_upstream',
          nextAction: 'publish'
        }
      })
    ).toBe('blocked')
  })

  it('surfaces the commit failure summary in the Create PR intent notice', () => {
    expect(
      getCreatePrIntentCommitFailureNoticeMessage(
        'husky - pre-commit hook\neslint found 2 errors\nfull output'
      )
    ).toBe('Commit blocked: Lint failed during commit. Fix the issue, then retry Create PR.')

    expect(getCreatePrIntentCommitFailureNoticeMessage(null)).toBe(
      'Could not commit changes. Fix the issue, then retry Create PR.'
    )

    expect(
      getCreatePrIntentCommitFailureNoticeMessage('pre-commit hook failed', {
        fallback: 'fallback',
        withSummary: (summary) => `localized ${summary}`
      })
    ).toBe('localized Pre-commit hook failed.')
  })
})
