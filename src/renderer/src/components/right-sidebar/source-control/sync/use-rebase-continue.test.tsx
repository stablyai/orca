// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContinueRebaseResult } from '../../../../../../shared/git/status/git-status-types'
import { deferred, flush } from './rebase-hook-test-harness'
import { getWorktreeOperationStore } from '../panel/worktree-operation-store'
import { useSourceControlRebaseContinue } from './use-rebase-continue'

const git = vi.hoisted(() => ({ continueRebase: vi.fn<() => Promise<ContinueRebaseResult>>() }))
vi.mock('@/runtime/source-control/git/runtime-git-rebase-client', () => ({
  continueRuntimeGitRebase: git.continueRebase
}))
vi.mock('./remote-refresh', () => ({ refreshSourceControlAfterRemoteAction: vi.fn() }))

afterEach(() => {
  cleanup()
  git.continueRebase.mockReset()
})

function inspected(head: string): ContinueRebaseResult {
  return {
    outcome: 'inspected',
    stop: { head, step: '1', incarnation: `rebase-merge:1:0:${head}` },
    branch: 'feature'
  }
}

it('re-reads the stop when HEAD moves mid-inspect and ignores the superseded reading', async () => {
  const operationStore = getWorktreeOperationStore('wt-continue', 'local', 'instance-1')
  const first = deferred<ContinueRebaseResult>()
  const second = deferred<ContinueRebaseResult>()
  git.continueRebase.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const noop = async () => {}
  const activeRepoTarget = { kind: 'local' as const }
  const props = (statusHead: string) => ({
    activeRepoTarget,
    activeWorktreeId: 'wt-continue',
    conflictOperation: 'rebase' as const,
    operationStore,
    rebaseStopUnread: true,
    refreshActiveGitStatusAfterMutation: noop,
    refreshBranchCompareRef: { current: noop },
    refreshGitHistoryRef: { current: noop },
    statusHead,
    rebaseStop: null,
    inspectFailure: null,
    indexObservation: null,
    worktreePath: '/repo'
  })
  const { rerender } = renderHook(
    (p: ReturnType<typeof props>) => useSourceControlRebaseContinue(p),
    {
      initialProps: props('S1')
    }
  )

  // HEAD moved while the S1 inspection was still in flight: a fresh read starts for S2.
  rerender(props('S2'))

  await act(async () => second.resolve(inspected('S2')))
  await act(async () => first.resolve(inspected('S1')))
  await flush()
  expect(operationStore.getState().rebaseStop?.token.head).toBe('S2')
})

it('rechecks a late empty result against the newer index observation', async () => {
  const operationStore = getWorktreeOperationStore('wt-empty-race', 'local', 'instance-1')
  const token = { head: 'S1', step: '1', incarnation: 'run-1' }
  operationStore.setState({ rebaseStop: { token, branch: 'feature', blocked: null } })
  const pending = deferred<ContinueRebaseResult>()
  git.continueRebase.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
    outcome: 'inspected',
    stop: token,
    branch: 'feature',
    indexObservation: 'index-b',
    hasStagedChanges: true
  })
  const target = { kind: 'local' as const }
  const noop = async () => {}
  const { useStore } = await import('zustand')
  const { result, rerender } = renderHook(
    ({ indexObservation }: { indexObservation: string }) => {
      const rebaseStop = useStore(operationStore, (state) => state.rebaseStop)
      const inspectFailure = useStore(operationStore, (state) => state.rebaseStopInspectFailure)
      return useSourceControlRebaseContinue({
        activeRepoTarget: target,
        activeWorktreeId: 'wt-empty-race',
        conflictOperation: 'rebase',
        operationStore,
        rebaseStopUnread: !rebaseStop && !inspectFailure,
        rebaseStop,
        inspectFailure,
        indexObservation,
        refreshActiveGitStatusAfterMutation: noop,
        refreshBranchCompareRef: { current: noop },
        refreshGitHistoryRef: { current: noop },
        statusHead: 'S1',
        worktreePath: '/repo'
      })
    },
    { initialProps: { indexObservation: 'index-a' } }
  )
  let continuation!: Promise<void>
  act(() => {
    continuation = result.current.handleContinueRebase()
  })
  rerender({ indexObservation: 'index-b' })
  await act(async () => {
    pending.resolve({
      outcome: 'empty',
      stop: token,
      branch: 'feature',
      indexObservation: 'index-a'
    })
    await continuation
    await flush()
  })
  await act(flush)
  expect(operationStore.getState().rebaseStop).toMatchObject({
    token,
    blocked: null,
    indexObservation: 'index-b'
  })
})

it('keeps Retry busy until the current inspection settles', async () => {
  const operationStore = getWorktreeOperationStore('wt-retry-race', 'local', 'instance-1')
  operationStore.setState({
    rebaseStop: null,
    rebaseStopInspectFailure: { head: 'S1', message: null }
  })
  const first = deferred<ContinueRebaseResult>()
  const second = deferred<ContinueRebaseResult>()
  git.continueRebase.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const target = { kind: 'local' as const }
  const noop = async () => {}
  const { useStore } = await import('zustand')
  const { result, rerender } = renderHook(
    ({ head }: { head: string }) => {
      const rebaseStop = useStore(operationStore, (state) => state.rebaseStop)
      const inspectFailure = useStore(operationStore, (state) => state.rebaseStopInspectFailure)
      return useSourceControlRebaseContinue({
        activeRepoTarget: target,
        activeWorktreeId: 'wt-retry-race',
        conflictOperation: 'rebase',
        operationStore,
        rebaseStopUnread: !rebaseStop && !inspectFailure,
        rebaseStop,
        inspectFailure,
        indexObservation: null,
        refreshActiveGitStatusAfterMutation: noop,
        refreshBranchCompareRef: { current: noop },
        refreshGitHistoryRef: { current: noop },
        statusHead: head,
        worktreePath: '/repo'
      })
    },
    { initialProps: { head: 'S1' } }
  )
  act(() => result.current.handleRetryRebaseInspect())
  expect(result.current.isRetryingRebaseInspect).toBe(true)
  rerender({ head: 'S2' })
  await act(async () => {
    first.resolve(inspected('S1'))
    await flush()
  })
  expect(result.current.isRetryingRebaseInspect).toBe(true)
  await act(async () => {
    second.resolve(inspected('S2'))
    await flush()
  })
  expect(result.current.isRetryingRebaseInspect).toBe(false)
  expect(operationStore.getState().rebaseStop?.token.head).toBe('S2')
})

it('offers Retry for a failed read or an incomplete stop even when HEAD is null', async () => {
  const { resolveRebaseContinueState } = await import('../panel/base-rebase-state')
  expect(resolveRebaseContinueState(null, null, { head: null, message: null })).toBe('unreadable')
  expect(
    resolveRebaseContinueState(
      { token: { head: null, step: '1', incarnation: 'run' }, branch: 'feature', blocked: null },
      'S1'
    )
  ).toBe('unreadable')
  expect(
    resolveRebaseContinueState(
      { token: { head: 'S1', step: '1', incarnation: 'run' }, branch: 'feature', blocked: null },
      'S1'
    )
  ).toBe('ready')
})

it('offers recovery after a fulfilled inspection failure and accepts a complete retry', async () => {
  const operationStore = getWorktreeOperationStore('wt-inspect-failure', 'local', 'instance-1')
  git.continueRebase
    .mockResolvedValueOnce({ outcome: 'failed', message: 'older host' })
    .mockResolvedValueOnce(inspected('S1'))
  const target = { kind: 'local' as const }
  const noop = async () => {}
  const { useStore } = await import('zustand')
  const { resolveRebaseContinueState } = await import('../panel/base-rebase-state')
  const { result } = renderHook(() => {
    const rebaseStop = useStore(operationStore, (state) => state.rebaseStop)
    const inspectFailure = useStore(operationStore, (state) => state.rebaseStopInspectFailure)
    const state = resolveRebaseContinueState(rebaseStop, 'S1', inspectFailure)
    return {
      state,
      ...useSourceControlRebaseContinue({
        activeRepoTarget: target,
        activeWorktreeId: 'wt-inspect-failure',
        conflictOperation: 'rebase',
        operationStore,
        rebaseStopUnread: state === 'unknown',
        rebaseStop,
        inspectFailure,
        indexObservation: null,
        refreshActiveGitStatusAfterMutation: noop,
        refreshBranchCompareRef: { current: noop },
        refreshGitHistoryRef: { current: noop },
        statusHead: 'S1',
        worktreePath: '/repo'
      })
    }
  })
  await act(flush)
  expect(result.current.state).toBe('unreadable')
  await act(async () => {
    result.current.handleRetryRebaseInspect()
    await flush()
  })
  await act(flush)
  expect(result.current.state).toBe('ready')
})

it('ignores an inspection superseded by staging and unstaging during the read', async () => {
  const operationStore = getWorktreeOperationStore('wt-unstage-race', 'local', 'instance-1')
  const token = { head: 'S1', step: '1', incarnation: 'run-1' }
  operationStore.setState({
    rebaseStop: { token, branch: 'feature', blocked: 'empty', indexObservation: 'index-a' }
  })
  const pending = deferred<ContinueRebaseResult>()
  git.continueRebase.mockReturnValueOnce(pending.promise)
  const target = { kind: 'local' as const }
  const noop = async () => {}
  const { useStore } = await import('zustand')
  const { rerender } = renderHook(
    ({ indexObservation }: { indexObservation: string }) => {
      const rebaseStop = useStore(operationStore, (state) => state.rebaseStop)
      const inspectFailure = useStore(operationStore, (state) => state.rebaseStopInspectFailure)
      return useSourceControlRebaseContinue({
        activeRepoTarget: target,
        activeWorktreeId: 'wt-unstage-race',
        conflictOperation: 'rebase',
        operationStore,
        rebaseStopUnread: false,
        rebaseStop,
        inspectFailure,
        indexObservation,
        refreshActiveGitStatusAfterMutation: noop,
        refreshBranchCompareRef: { current: noop },
        refreshGitHistoryRef: { current: noop },
        statusHead: 'S1',
        worktreePath: '/repo'
      })
    },
    { initialProps: { indexObservation: 'index-b' } }
  )
  rerender({ indexObservation: 'index-a' })
  await act(async () => {
    pending.resolve({
      outcome: 'inspected',
      stop: token,
      branch: 'feature',
      indexObservation: 'index-b',
      hasStagedChanges: true
    })
    await flush()
  })
  expect(operationStore.getState().rebaseStop).toMatchObject({
    token,
    blocked: 'empty',
    indexObservation: 'index-a'
  })
})
