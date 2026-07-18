import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createCreatePrIntentRunToken,
  createPrIntentCurrentTargetConflictsWithToken,
  createPrIntentGitStatusMatchesToken,
  createPrIntentRunTokenMatches,
  getCreatePrIntentCommitFailureNoticeMessage,
  getCreatePrIntentStagePaths,
  isCreatePrIntentSyncConflictError,
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

  it('prefers the remote-validated eligibility default so it cannot diverge from the composer', () => {
    // Why: the intent flow's eligibility is recomputed from the same compare
    // base right before creation, so its default already corrects a local-only
    // stacked parent to the repo default. The one-click path must target that
    // same base as the composer, not the raw (possibly unpushable) compare base.
    expect(
      resolveCreatePrIntentReviewBase({
        currentBaseRef: 'stacked-parent',
        eligibilityDefaultBaseRef: 'refs/remotes/origin/main',
        composerBaseRef: 'main'
      })
    ).toBe('main')

    expect(
      resolveCreatePrIntentReviewBase({
        currentBaseRef: null,
        eligibilityDefaultBaseRef: 'refs/remotes/upstream/develop',
        composerBaseRef: 'main'
      })
    ).toBe('develop')
  })

  it('falls back to the compare base when eligibility supplies no default', () => {
    // Why: never blank the base. If the main process could not resolve a default
    // (no candidate on remote and repo default unavailable), keep the user's
    // compare base rather than dropping to an empty target.
    expect(
      resolveCreatePrIntentReviewBase({
        currentBaseRef: 'refs/remotes/origin/release',
        eligibilityDefaultBaseRef: null,
        composerBaseRef: 'main'
      })
    ).toBe('release')
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

  it('syncs behind-only branches, blocks diverged and unpublished-without-commits branches', () => {
    // Genuinely diverged (local + non-equivalent remote commits): auto-syncing
    // would merge without consent, so the intent flow keeps the explicit stop.
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

    // Behind with no local commits (pure fast-forward case) auto-syncs.
    expect(
      resolveCreatePrIntentRemoteStep({
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 3 },
        hasCurrentBranch: true,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_sync',
          nextAction: 'sync'
        }
      })
    ).toBe('sync')

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

  it('treats only a genuine merge-conflict sync failure as a conflict for notice copy', () => {
    // Pull/merge conflict from this sync: the user must resolve conflicts.
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        syncPushStage: false,
        rawError: 'CONFLICT (content): Merge conflict in src/app.ts'
      })
    ).toBe(true)
    // An unconcluded prior merge also counts as a conflict to resolve.
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        rawError: 'error: you have not concluded your merge (MERGE_HEAD exists).'
      })
    ).toBe(true)

    // A fetch/network/auth failure during sync is NOT a conflict, even though it
    // is not marked as the push stage — it must fall to the generic copy.
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        syncPushStage: false,
        rawError: 'fatal: Authentication failed for remote'
      })
    ).toBe(false)
    // No raw error at all is not a conflict.
    expect(isCreatePrIntentSyncConflictError({ kind: 'sync' })).toBe(false)

    // Push-stage rejection during sync is a push failure, not a conflict.
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        syncPushStage: true,
        rawError: 'CONFLICT (content): Merge conflict in src/app.ts'
      })
    ).toBe(false)

    // Non-sync remote failures never use the conflict copy.
    expect(isCreatePrIntentSyncConflictError({ kind: 'push' })).toBe(false)
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'force_push',
        syncPushStage: false,
        rawError: 'CONFLICT (content): Merge conflict in src/app.ts'
      })
    ).toBe(false)
    expect(isCreatePrIntentSyncConflictError(null)).toBe(false)
    expect(isCreatePrIntentSyncConflictError(undefined)).toBe(false)
  })

  it('recognizes every merge-conflict wording git can emit during sync', () => {
    // The fresh-conflict pattern's other alternatives: "Automatic merge failed"
    // and "fix conflicts" are the most common real pull output.
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        syncPushStage: false,
        rawError: 'Automatic merge failed; fix conflicts and then commit the result.'
      })
    ).toBe(true)
    // The unconcluded-merge pattern's other alternatives: "unmerged files" and
    // "needs merge".
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        rawError: 'error: Pulling is not possible because you have unmerged files.'
      })
    ).toBe(true)
    expect(
      isCreatePrIntentSyncConflictError({
        kind: 'sync',
        rawError: "error: path 'src/app.ts' needs merge"
      })
    ).toBe(true)
  })
})
