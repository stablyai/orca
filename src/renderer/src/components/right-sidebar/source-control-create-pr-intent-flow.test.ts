import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createCreatePrIntentRunToken,
  createPrIntentCurrentTargetConflictsWithToken,
  createPrIntentGitStatusMatchesToken,
  createPrIntentRunTokenMatches,
  getCreatePrIntentStagePaths,
  resolveCreatePrIntentRemoteStep
} from './source-control-create-pr-intent-flow'
import type { GitStatusEntry } from '../../../../shared/types'

describe('source-control Create PR intent flow helpers', () => {
  it('matches async completions only to the original repo, worktree, path, and branch', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123)
    try {
      const token = createCreatePrIntentRunToken({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        branch: 'feature'
      })

      expect(token.startedAt).toBe(123)
      expect(createPrIntentRunTokenMatches(token, token)).toBe(true)
      expect(createPrIntentRunTokenMatches(token, { ...token, branch: 'other' })).toBe(false)
      expect(createPrIntentRunTokenMatches(token, { ...token, worktreeId: 'wt-2' })).toBe(false)
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
})
