import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import {
  createPullRequestGenerationSlice,
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationSuccess
} from '@/store/slices/hosted-review/generation/pull-request-generation'
import type { PullRequestGenerationSlice } from '@/store/slices/hosted-review/generation/pull-request-generation-state'

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

function createPullRequestGenerationTestStore() {
  return create<PullRequestGenerationSlice>()((...args) =>
    createPullRequestGenerationSlice(
      ...(args as unknown as Parameters<typeof createPullRequestGenerationSlice>)
    )
  )
}

describe('SourceControl pull request generation records', () => {
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
          runtimeTarget: { kind: 'local' as const },
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
          runtimeTarget: { kind: 'local' as const },
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
          runtimeTarget: { kind: 'local' as const },
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
          runtimeTarget: { kind: 'local' as const },
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
