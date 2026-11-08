// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { SequencerRecoveryControls } from './sequencer-recovery-controls'
import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/git-graph-tab'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'

const { status, continued } = vi.hoisted(() => ({ status: vi.fn(), continued: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-commit-actions-client', () => ({
  sequencerContinueRuntimeGit: continued
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitStatus: status
}))
vi.mock('@/runtime/source-control/git/git-commit-actions-capability', () => ({
  useGitCommitActionsSupport: () => ({ supported: true }),
  gitCommitActionsSupported: async () => true
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('./use-worktree-context', () => ({
  useSourceControlWorktreeContext: () => ({ activeWorktreeId: 'wt', worktreePath: '/repo' })
}))
vi.mock('@/lib/worktree-git-copy', () => ({
  resolveWorktreeGitCopyNow: () => ({
    worktreeId: 'wt',
    hostId: useAppStore.getState().activeWorkspaceExecutionHostId,
    transport: { kind: 'local' },
    connectionId: undefined
  })
}))

it('fences late recovery status while invalidating the original graph after navigation', async () => {
  const initial = useAppStore.getState()
  const pending = Promise.withResolvers<GitStatusResult>()
  const fetching = Promise.withResolvers<void>()
  let accepted: GitStatusResult = { entries: [], head: 'host-A', conflictOperation: 'cherry-pick' }
  useAppStore.setState({
    activeWorktreeId: 'wt',
    activeWorkspaceExecutionHostId: 'local',
    setGitStatus: (_id, result) => {
      accepted = result
    },
    updateWorktreeGitIdentity: () => {},
    fetchUpstreamStatus: async () => null
  })
  status.mockImplementation(() => {
    fetching.resolve()
    return pending.promise
  })
  continued.mockResolvedValue(undefined)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let invalidatedWorktree: unknown
  const onGraphRefresh = (event: Event) => {
    if (event instanceof CustomEvent) {
      invalidatedWorktree = event.detail
    }
  }
  try {
    await act(async () =>
      root.render(
        <SequencerRecoveryControls worktreeId="wt" operation="cherry-pick" disabled={false} />
      )
    )
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await fetching.promise
    })
    await act(async () => useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:B' }))
    accepted = { entries: [], head: 'host-B', conflictOperation: 'revert' }
    await act(async () => {
      pending.resolve({ entries: [], head: 'host-A-clean', conflictOperation: 'unknown' })
      await pending.promise
    })
    expect(accepted).toEqual({ entries: [], head: 'host-B', conflictOperation: 'revert' })

    const recovering = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    continued.mockImplementation(() => {
      started.resolve()
      return recovering.promise
    })
    window.addEventListener(GIT_GRAPH_REFRESH_EVENT, onGraphRefresh)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await started.promise
    })
    await act(async () => useAppStore.setState({ activeWorktreeId: 'other' }))
    await act(async () => {
      recovering.resolve()
      await recovering.promise
    })
    expect(invalidatedWorktree).toBe('wt')
    expect(accepted).toEqual({ entries: [], head: 'host-B', conflictOperation: 'revert' })
  } finally {
    window.removeEventListener(GIT_GRAPH_REFRESH_EVENT, onGraphRefresh)
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(initial, true)
  }
})
