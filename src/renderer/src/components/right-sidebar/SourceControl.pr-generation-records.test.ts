import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import {
  arePullRequestGenerationFieldsEqual,
  clearPullRequestGenerationRequiresPushBeforeCreate,
  createPullRequestGenerationSlice,
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  getPullRequestGenerationSeedRestoreKey,
  getPullRequestGenerationWorktreeKey,
  markPullRequestGenerationRequiresPushBeforeCreate,
  markPullRequestGenerationTerminalSeedRestored,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationSuccess,
  shouldApplyPullRequestGenerationResult,
  shouldHydratePullRequestGenerationResult,
  type PullRequestGenerationSlice,
  type PullRequestGenerationRecord
} from '@/store/slices/pull-request-generation'

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
    requiresPushBeforeCreate: false,
    status: 'running' as const,
    result: null,
    error: null,
    hydrated: false,
    ...overrides
  }
}

function createPullRequestGenerationTestStore() {
  return create<PullRequestGenerationSlice>()((...args) =>
    createPullRequestGenerationSlice(
      ...(args as unknown as Parameters<typeof createPullRequestGenerationSlice>)
    )
  )
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

  it('restores terminal failed and canceled seeds once after remount', () => {
    const failed = runningRecord({
      status: 'failed',
      error: 'Model failed'
    })
    const canceled = runningRecord({
      status: 'canceled',
      error: null
    })

    expect(
      getPullRequestGenerationSeedRestoreKey({
        recordKey: 'pr-record',
        record: failed
      })
    ).toBe('pr-record:3:failed')
    expect(
      getPullRequestGenerationSeedRestoreKey({
        recordKey: 'pr-record',
        record: canceled
      })
    ).toBe('pr-record:3:canceled')

    const restored = markPullRequestGenerationTerminalSeedRestored({
      record: failed,
      requestId: 3
    })
    expect(restored).toMatchObject({
      status: 'failed',
      hydrated: true
    })
    expect(
      getPullRequestGenerationSeedRestoreKey({
        recordKey: 'pr-record',
        record: restored
      })
    ).toBeNull()
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

  it('keeps PR generation results in the store after the composer unmounts', () => {
    const store = createPullRequestGenerationTestStore()
    const key = getPullRequestGenerationRecordKey({
      worktreeId: 'wt-a',
      worktreePath: '/repo/a',
      repoId: 'repo-1',
      branch: 'feature-a'
    })
    expect(key).not.toBeNull()
    const record = createRunningPullRequestGenerationRecord(
      {
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        connectionId: 'conn-a',
        requestId: 1,
        repoId: 'repo-1',
        branch: 'feature-a',
        runtimeTargetSettings: { activeRuntimeEnvironmentId: 'runtime-a' }
      },
      seed,
      fieldRevisions
    )
    store.getState().setPullRequestGenerationRecord(key!, record)

    const generated = {
      base: 'main',
      title: 'Generated after tab switch',
      body: 'Generated body',
      draft: false
    }
    store.getState().updatePullRequestGenerationRecord(key!, (current) =>
      resolvePullRequestGenerationSuccess({
        record: current,
        requestId: 1,
        result: generated
      })
    )

    expect(store.getState().pullRequestGenerationRecords[key!]).toMatchObject({
      context: { runtimeTargetSettings: { activeRuntimeEnvironmentId: 'runtime-a' } },
      status: 'succeeded',
      result: generated,
      hydrated: false
    })
  })

  it('persists branch-preparation push requirement until create succeeds', () => {
    const record = createRunningPullRequestGenerationRecord(
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

    const marked = markPullRequestGenerationRequiresPushBeforeCreate({
      record,
      requestId: 1
    })
    expect(marked?.requiresPushBeforeCreate).toBe(true)

    const completed = resolvePullRequestGenerationSuccess({
      record: marked,
      requestId: 1,
      result: {
        base: 'main',
        title: 'Generated after branch preparation',
        body: 'Generated body',
        draft: false
      }
    })
    expect(completed).toMatchObject({
      status: 'succeeded',
      requiresPushBeforeCreate: true
    })

    expect(clearPullRequestGenerationRequiresPushBeforeCreate(completed)).toMatchObject({
      requiresPushBeforeCreate: false
    })
  })

  it('prunes PR generation records for removed worktrees', () => {
    const store = createPullRequestGenerationTestStore()
    const keyA = getPullRequestGenerationRecordKey({
      worktreeId: 'wt-a',
      worktreePath: '/repo/a',
      repoId: 'repo-1',
      branch: 'feature-a'
    })!
    const keyB = getPullRequestGenerationRecordKey({
      worktreeId: 'wt-b',
      worktreePath: '/repo/b',
      repoId: 'repo-1',
      branch: 'feature-b'
    })!
    store.getState().setPullRequestGenerationRecord(
      keyA,
      createRunningPullRequestGenerationRecord(
        {
          worktreeId: 'wt-a',
          worktreePath: '/repo/a',
          requestId: 1,
          repoId: 'repo-1',
          branch: 'feature-a'
        },
        seed,
        fieldRevisions
      )
    )
    store.getState().setPullRequestGenerationRecord(
      keyB,
      createRunningPullRequestGenerationRecord(
        {
          worktreeId: 'wt-b',
          worktreePath: '/repo/b',
          requestId: 2,
          repoId: 'repo-1',
          branch: 'feature-b'
        },
        seed,
        fieldRevisions
      )
    )

    store.getState().prunePullRequestGenerationRecords(new Set(['wt-a']))

    expect(Object.keys(store.getState().pullRequestGenerationRecords)).toEqual([keyA])
  })

  it('does not reuse PR generation request ids across composer remounts', () => {
    const store = createPullRequestGenerationTestStore()
    const key = getPullRequestGenerationRecordKey({
      worktreeId: 'wt-a',
      worktreePath: '/repo/a',
      repoId: 'repo-1',
      branch: 'feature-a'
    })
    expect(key).not.toBeNull()
    const firstRequestId = store.getState().allocatePullRequestGenerationRequestId()
    store.getState().setPullRequestGenerationRecord(
      key!,
      createRunningPullRequestGenerationRecord(
        {
          worktreeId: 'wt-a',
          worktreePath: '/repo/a',
          connectionId: 'conn-a',
          requestId: firstRequestId,
          repoId: 'repo-1',
          branch: 'feature-a'
        },
        seed,
        fieldRevisions
      )
    )
    store.getState().updatePullRequestGenerationRecord(key!, resolvePullRequestGenerationCancel)

    const secondRequestId = store.getState().allocatePullRequestGenerationRequestId()
    expect(secondRequestId).toBeGreaterThan(firstRequestId)
    store.getState().setPullRequestGenerationRecord(
      key!,
      createRunningPullRequestGenerationRecord(
        {
          worktreeId: 'wt-a',
          worktreePath: '/repo/a',
          connectionId: 'conn-a',
          requestId: secondRequestId,
          repoId: 'repo-1',
          branch: 'feature-a'
        },
        seed,
        fieldRevisions
      )
    )

    const staleResult = {
      base: 'main',
      title: 'Stale generated title',
      body: 'Stale body',
      draft: false
    }
    store.getState().updatePullRequestGenerationRecord(key!, (current) =>
      resolvePullRequestGenerationSuccess({
        record: current,
        requestId: firstRequestId,
        result: staleResult
      })
    )

    expect(store.getState().pullRequestGenerationRecords[key!]).toMatchObject({
      status: 'running',
      result: null
    })
  })
})
