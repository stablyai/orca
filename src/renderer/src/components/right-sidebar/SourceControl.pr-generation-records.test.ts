import { describe, expect, it } from 'vitest'
import {
  arePullRequestGenerationFieldsEqual,
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  getPullRequestGenerationWorktreeKey,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationSuccess,
  shouldApplyPullRequestGenerationResult,
  shouldHydratePullRequestGenerationResult,
  type PullRequestGenerationRecord
} from './SourceControl'

const seed = {
  base: 'main',
  title: 'feat: add worktree-safe generation',
  body: 'Body',
  draft: false
}

const fieldRevisions = {
  base: 0,
  title: 0,
  body: 0,
  draft: 0
}

function runningRecord(overrides: Partial<PullRequestGenerationRecord> = {}) {
  return {
    context: {
      worktreeId: 'wt-a',
      worktreePath: '/repo/a',
      connectionId: 'conn-a',
      requestId: 3,
      repoId: 'repo-1',
      branch: 'feature-a'
    },
    seed,
    seedFieldRevisions: fieldRevisions,
    status: 'running' as const,
    result: null,
    error: null,
    hydrated: false,
    ...overrides
  }
}

describe('SourceControl pull request generation records', () => {
  it('keys PR generation by worktree id and falls back to path', () => {
    expect(getPullRequestGenerationWorktreeKey('wt-a', '/repo/a')).toBe('wt-a')
    expect(getPullRequestGenerationWorktreeKey(null, '/repo/a')).toBe('/repo/a')
    expect(getPullRequestGenerationWorktreeKey(null, '')).toBeNull()
    expect(
      getPullRequestGenerationRecordKey({
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        repoId: 'repo-1',
        branch: 'feature-a'
      })
    ).not.toBe(
      getPullRequestGenerationRecordKey({
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        repoId: 'repo-1',
        branch: 'feature-b'
      })
    )
  })

  it('applies generated PR fields only to the original running request', () => {
    expect(
      shouldApplyPullRequestGenerationResult({
        record: runningRecord(),
        requestId: 3
      })
    ).toBe(true)

    expect(
      shouldApplyPullRequestGenerationResult({
        record: runningRecord(),
        requestId: 4
      })
    ).toBe(false)

    expect(
      shouldApplyPullRequestGenerationResult({
        record: runningRecord({ status: 'succeeded' }),
        requestId: 3
      })
    ).toBe(false)
  })

  it('treats draft changes as stale PR generation input', () => {
    expect(arePullRequestGenerationFieldsEqual(seed, { ...seed, draft: true })).toBe(false)
  })

  it('rehydrates a completed result until it is marked hydrated', () => {
    const record = runningRecord({
      status: 'succeeded',
      result: { ...seed, title: 'Generated title' }
    })

    expect(
      shouldHydratePullRequestGenerationResult({
        record
      })
    ).toBe(true)

    expect(
      shouldHydratePullRequestGenerationResult({
        record: { ...record, hydrated: true }
      })
    ).toBe(false)
  })

  it('keeps a switched-away PR generation owned by the original worktree', () => {
    const worktreeA = createRunningPullRequestGenerationRecord(
      {
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        connectionId: 'conn-a',
        requestId: 1,
        repoId: 'repo-1',
        branch: 'feature-a'
      },
      seed,
      fieldRevisions
    )
    const records: Record<string, PullRequestGenerationRecord> = {
      'wt-a': worktreeA
    }

    // Switching to B and pressing stop must not manufacture or cancel A's record.
    const canceledB = resolvePullRequestGenerationCancel(records['wt-b'])
    expect(canceledB).toBeNull()
    expect(records['wt-a'].status).toBe('running')

    const generated = {
      base: 'main',
      title: 'Generated PR title',
      body: 'Generated body',
      draft: false
    }
    const completedA = resolvePullRequestGenerationSuccess({
      record: records['wt-a'],
      requestId: 1,
      result: generated
    })

    expect(completedA).toMatchObject({
      status: 'succeeded',
      result: generated,
      hydrated: false
    })
    expect(
      shouldHydratePullRequestGenerationResult({
        record: completedA
      })
    ).toBe(true)
  })
})
