// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { flush } from '../panel/source-control-hook-test-harness'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorktreeOperationStore } from '../panel/worktree-operation-store'
import { useRebaseAutoStashProbe } from './use-rebase-auto-stash-probe'

const probe = vi.hoisted(() => ({ read: vi.fn<() => Promise<boolean | 'unsupported'>>() }))
vi.mock('@/runtime/source-control/git/runtime-git-rebase-client', () => ({
  readRuntimeGitRebaseAutoStash: probe.read
}))

afterEach(() => {
  cleanup()
  probe.read.mockReset()
})

it('forgets an earlier rebase.autoStash answer when a later probe fails', async () => {
  const operationStore = getWorktreeOperationStore('wt-probe', 'local', 'instance-1')
  operationStore.setState({ rebaseAutoStash: true })
  probe.read.mockRejectedValue(new Error('host unreachable'))

  renderHook(() =>
    useRebaseAutoStashProbe({
      activeRepoTarget: { kind: 'local' },
      activeWorktreeId: 'wt-probe',
      operationStore,
      shouldProbe: true,
      worktreePath: '/repo'
    })
  )

  await flush()
  expect(probe.read).toHaveBeenCalledTimes(1)
  // A failed re-read must not leave the old `true` enabling Rebase over a dirty tree.
  expect(operationStore.getState().rebaseAutoStash).toBeNull()
})
