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
  const props = (statusHead: string) => ({
    activeRepoTarget: { kind: 'local' as const },
    activeWorktreeId: 'wt-continue',
    conflictOperation: 'rebase' as const,
    operationStore,
    rebaseStopUnread: true,
    refreshActiveGitStatusAfterMutation: noop,
    refreshBranchCompareRef: { current: noop },
    refreshGitHistoryRef: { current: noop },
    statusHead,
    worktreePath: '/repo'
  })
  const { rerender } = renderHook(
    (p: ReturnType<typeof props>) => useSourceControlRebaseContinue(p),
    {
      initialProps: props('S1')
    }
  )
  expect(git.continueRebase).toHaveBeenCalledTimes(1)

  // HEAD moved while the S1 inspection was still in flight: a fresh read starts for S2.
  rerender(props('S2'))
  expect(git.continueRebase).toHaveBeenCalledTimes(2)

  await act(async () => second.resolve(inspected('S2')))
  await act(async () => first.resolve(inspected('S1')))
  await flush()
  expect(operationStore.getState().rebaseStop?.token.head).toBe('S2')
})

function hookProps(operationStore: ReturnType<typeof getWorktreeOperationStore>, unread: boolean) {
  const noop = async () => {}
  return {
    activeRepoTarget: { kind: 'local' as const },
    activeWorktreeId: 'wt-continue',
    conflictOperation: 'rebase' as const,
    operationStore,
    rebaseStopUnread: unread,
    refreshActiveGitStatusAfterMutation: noop,
    refreshBranchCompareRef: { current: noop },
    refreshGitHistoryRef: { current: noop },
    statusHead: 'S1',
    worktreePath: '/repo'
  }
}

it('records a failed automatic inspect for this HEAD, and Retry reads the stop again', async () => {
  const operationStore = getWorktreeOperationStore('wt-inspect-fail', 'local', 'instance-1')
  git.continueRebase.mockRejectedValueOnce(new Error('WSL distro Ubuntu is not running'))
  const { rerender, result } = renderHook(
    (p: ReturnType<typeof hookProps>) => useSourceControlRebaseContinue(p),
    { initialProps: hookProps(operationStore, true) }
  )
  await flush()
  expect(operationStore.getState().rebaseStopInspectFailure).toEqual({
    head: 'S1',
    message: 'WSL distro Ubuntu is not running'
  })

  // The panel stops calling the stop unread while it shows the failure, so nothing re-reads on its own.
  rerender(hookProps(operationStore, false))
  expect(git.continueRebase).toHaveBeenCalledTimes(1)

  git.continueRebase.mockResolvedValueOnce(inspected('S1'))
  act(() => result.current.handleRetryRebaseInspect())
  expect(operationStore.getState().rebaseStopInspectFailure).toBeNull()
  rerender(hookProps(operationStore, true))
  await flush()
  expect(git.continueRebase).toHaveBeenCalledTimes(2)
  expect(operationStore.getState().rebaseStop?.token.head).toBe('S1')
  expect(operationStore.getState().rebaseStopInspectFailure).toBeNull()
})

it('sends Skip only for an empty step, with the stop that was shown', async () => {
  const operationStore = getWorktreeOperationStore('wt-skip', 'local', 'instance-1')
  const stop = { head: 'S1', step: '2', incarnation: 'rebase-apply:1:0:S1' }
  operationStore.setState({ rebaseStop: { token: stop, branch: 'feature', blocked: null } })
  const { result } = renderHook(() =>
    useSourceControlRebaseContinue(hookProps(operationStore, false))
  )

  await act(() => result.current.handleSkipRebaseStep())
  expect(git.continueRebase).not.toHaveBeenCalled()

  operationStore.setState({ rebaseStop: { token: stop, branch: 'feature', blocked: 'empty' } })
  git.continueRebase.mockResolvedValueOnce({ outcome: 'completed', branch: 'feature' })
  await act(() => result.current.handleSkipRebaseStep())
  expect(git.continueRebase).toHaveBeenCalledWith(expect.anything(), 'skip', { expected: stop })
  expect(operationStore.getState().isAbortingOperation).toBe(false)

  // Continue refuses the same empty step: Git would only report it empty again.
  operationStore.setState({ rebaseStop: { token: stop, branch: 'feature', blocked: 'empty' } })
  await act(() => result.current.handleContinueRebase())
  expect(git.continueRebase).toHaveBeenCalledTimes(1)
})
