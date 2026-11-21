// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContinueRebaseResult } from '../../../../../../shared/git/status/git-status-types'
import { deferred, flush } from '../panel/source-control-hook-test-harness'
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
