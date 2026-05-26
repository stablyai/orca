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

  it('applies generated PR fields only to the original running request with unchanged seed', () => {
    expect(
      shouldApplyPullRequestGenerationResult({
        record: runningRecord(),
        requestId: 3,
        currentFields: seed
      })
    ).toBe(true)

    expect(
      shouldApplyPullRequestGenerationResult({
        record: runningRecord(),
        requestId: 4,
        currentFields: seed
      })
    ).toBe(false)

    expect(
      shouldApplyPullRequestGenerationResult({
        record: runningRecord(),
        requestId: 3,
        currentFields: { ...seed, base: 'release' }
      })
    ).toBe(false)
  })

  it('treats draft changes as stale PR generation input', () => {
    expect(arePullRequestGenerationFieldsEqual(seed, { ...seed, draft: true })).toBe(false)
  })

  it('rehydrates a completed result only when the seed still matches', () => {
    const record = runningRecord({
      status: 'succeeded',
      result: { ...seed, title: 'Generated title' }
    })

    expect(
      shouldHydratePullRequestGenerationResult({
        record,
        currentFields: seed
      })
    ).toBe(true)

    expect(
      shouldHydratePullRequestGenerationResult({
        record,
        currentFields: { ...seed, body: 'Edited body' }
      })
    ).toBe(false)

    expect(
      shouldHydratePullRequestGenerationResult({
        record: { ...record, hydrated: true },
        currentFields: seed
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
      seed
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
      currentFields: seed,
      result: generated
    })

    expect(completedA).toMatchObject({
      status: 'succeeded',
      result: generated,
      hydrated: false
    })
    expect(
      shouldHydratePullRequestGenerationResult({
        record: completedA,
        currentFields: seed
      })
    ).toBe(true)
  })
})
