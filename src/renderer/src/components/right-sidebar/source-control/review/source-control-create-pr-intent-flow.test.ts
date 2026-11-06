import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createCreatePrIntentRunToken,
  createPrIntentCurrentTargetConflictsWithToken,
  resolveCreatePrIntentReviewBase,
  resolveCreatePrIntentGeneratedReviewFields
} from './create-pr-intent-flow'

describe('source-control Create PR intent flow helpers', () => {
  it('does not treat navigating to another worktree as an intent conflict', () => {
    const wt1Path = join(sep, 'repo', 'wt-1')
    const wt2Path = join(sep, 'repo', 'wt-2')

    const token = createCreatePrIntentRunToken({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath: wt1Path,
      branch: 'feature/pr',
      provider: 'github',
      pinnedCopy: null
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
      provider: 'github',
      baseRef: 'refs/remotes/origin/main',
      pinnedCopy: null
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

  it('prefers the remote-validated eligibility default so it cannot diverge from the composer', () => {
    // Match the composer's remote-validated base default so one-click creation cannot target an unpushable local stack parent.
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

  it('keeps generated review fields fail-closed', () => {
    const current = {
      base: 'main',
      title: 'Feature branch',
      body: '',
      draft: false
    }

    expect(
      resolveCreatePrIntentGeneratedReviewFields(current, {
        success: false,
        error: 'Agent timed out.'
      })
    ).toEqual({ ok: false, error: 'Agent timed out.' })
    expect(
      resolveCreatePrIntentGeneratedReviewFields(current, {
        success: true,
        fields: {
          base: 'other-base',
          title: 'Generated title',
          body: '## Problem\n\nDetails',
          draft: true
        }
      })
    ).toEqual({
      ok: true,
      fields: {
        base: 'main',
        title: 'Generated title',
        body: '## Problem\n\nDetails',
        draft: true
      }
    })
  })

  it('never downgrades a "Create as draft" choice to a ready review', () => {
    expect(
      resolveCreatePrIntentGeneratedReviewFields(
        { base: 'main', title: 'Feature branch', body: '', draft: true },
        {
          success: true,
          fields: { base: 'main', title: 'Generated title', body: 'Details', draft: false }
        }
      )
    ).toEqual({
      ok: true,
      fields: { base: 'main', title: 'Generated title', body: 'Details', draft: true }
    })
  })
})
