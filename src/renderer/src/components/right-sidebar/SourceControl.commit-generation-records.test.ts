import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import {
  createCommitMessageGenerationSlice,
  createRunningCommitMessageGenerationRecord,
  getCommitMessageGenerationRecordKey,
  markCommitMessageGenerationHydrated,
  resolveCommitMessageGenerationCancel,
  resolveCommitMessageGenerationFailure,
  resolveCommitMessageGenerationSuccess,
  type CommitMessageGenerationRecord,
  type CommitMessageGenerationSlice
} from '@/store/slices/commit-message-generation'

function runningRecord(overrides: Partial<CommitMessageGenerationRecord> = {}) {
  return {
    context: {
      worktreeId: 'wt-a',
      worktreePath: '/repo/a',
      connectionId: 'conn-a',
      requestId: 3
    },
    status: 'running' as const,
    message: null,
    error: null,
    hydrated: false,
    ...overrides
  }
}

function createCommitMessageGenerationTestStore() {
  return create<CommitMessageGenerationSlice>()((...args) =>
    createCommitMessageGenerationSlice(
      ...(args as unknown as Parameters<typeof createCommitMessageGenerationSlice>)
    )
  )
}

describe('SourceControl commit message generation records', () => {
  it('keys commit-message generation by worktree id and falls back to path', () => {
    expect(getCommitMessageGenerationRecordKey('wt-a', '/repo/a')).toBe('wt-a')
    expect(getCommitMessageGenerationRecordKey(null, '/repo/a')).toBe('/repo/a')
    expect(getCommitMessageGenerationRecordKey(null, '')).toBeNull()
  })

  it('applies generated messages only to the original running request', () => {
    expect(
      resolveCommitMessageGenerationSuccess({
        record: runningRecord(),
        requestId: 3,
        message: 'feat: generated'
      })
    ).toMatchObject({
      status: 'succeeded',
      message: 'feat: generated',
      hydrated: false
    })

    expect(
      resolveCommitMessageGenerationSuccess({
        record: runningRecord(),
        requestId: 4,
        message: 'feat: stale'
      })
    ).toBeNull()

    expect(
      resolveCommitMessageGenerationSuccess({
        record: runningRecord({ status: 'canceled' }),
        requestId: 3,
        message: 'feat: stale'
      })
    ).toBeNull()
  })

  it('preserves cancellation over later generator resolution', () => {
    const canceled = resolveCommitMessageGenerationCancel(runningRecord())

    expect(canceled).toMatchObject({
      status: 'canceled',
      error: null
    })
    expect(
      resolveCommitMessageGenerationFailure({
        record: canceled,
        requestId: 3,
        canceled: true,
        error: null
      })
    ).toBeNull()
  })

  it('marks completed messages as hydrated once the UI consumes them', () => {
    const hydrated = markCommitMessageGenerationHydrated(
      runningRecord({
        status: 'succeeded',
        message: 'docs: generated'
      })
    )

    expect(hydrated).toMatchObject({
      status: 'succeeded',
      message: 'docs: generated',
      hydrated: true
    })
  })

  it('stores running records in the generation slice', () => {
    const store = createCommitMessageGenerationTestStore()
    const key = getCommitMessageGenerationRecordKey('wt-a', '/repo/a')!
    const requestId = store.getState().allocateCommitMessageGenerationRequestId()

    store.getState().setCommitMessageGenerationRecord(
      key,
      createRunningCommitMessageGenerationRecord({
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        connectionId: 'conn-a',
        requestId,
        runtimeTargetSettings: { activeRuntimeEnvironmentId: 'runtime-a' }
      })
    )

    expect(store.getState().commitMessageGenerationRecords[key]).toMatchObject({
      context: {
        requestId,
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        runtimeTargetSettings: { activeRuntimeEnvironmentId: 'runtime-a' }
      },
      status: 'running'
    })
  })

  it('prunes commit generation records for removed worktrees', () => {
    const store = createCommitMessageGenerationTestStore()
    store.getState().setCommitMessageGenerationRecord(
      'wt-a',
      createRunningCommitMessageGenerationRecord({
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        requestId: 1
      })
    )
    store.getState().setCommitMessageGenerationRecord(
      'wt-b',
      createRunningCommitMessageGenerationRecord({
        worktreeId: 'wt-b',
        worktreePath: '/repo/b',
        requestId: 2
      })
    )

    store.getState().pruneCommitMessageGenerationRecords(new Set(['wt-a']))

    expect(Object.keys(store.getState().commitMessageGenerationRecords)).toEqual(['wt-a'])
  })
})
