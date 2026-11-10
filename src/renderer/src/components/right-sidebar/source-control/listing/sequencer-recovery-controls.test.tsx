// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { SequencerRecoveryControls } from './sequencer-recovery-controls'
import '@/lib/source-control/graph/git-graph-tab'
import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/source-control/graph/git-graph-refresh-event'
import { local } from '@/components/editor/git-graph/git-graph-workspace.test-fixtures'
import type * as WorktreeGitCopy from '@/lib/worktree-git-copy'
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
  useSourceControlWorktreeContext: () => ({ activeWorktreeId: 'r::/repo', worktreePath: '/repo' })
}))
vi.mock('@/lib/worktree-git-copy', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeGitCopy>()),
  resolveWorktreeGitCopyNow: () => ({
    worktreeId: 'r::/repo',
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
  const refreshed = Promise.withResolvers<void>()
  let requestedPublishTarget: unknown
  let acceptedUpstream: unknown
  useAppStore.setState({
    worktreesByRepo: {
      r: [
        { ...local, pushTarget: { remoteName: 'publish-a', branchName: 'topic-a' } },
        {
          ...local,
          hostId: 'ssh:B',
          pushTarget: { remoteName: 'publish-b', branchName: 'topic-b' }
        }
      ]
    },
    activeWorktreeId: 'r::/repo',
    activeWorkspaceExecutionHostId: 'local',
    setGitStatus: (_id, result) => {
      accepted = result
    },
    updateWorktreeGitIdentity: () => {},
    fetchUpstreamStatus: async (_id, _path, _connectionId, pushTarget) => {
      requestedPublishTarget = pushTarget
      return { hasUpstream: true, ahead: 2, behind: 0 }
    },
    setUpstreamStatus: (_id, upstream) => {
      acceptedUpstream = upstream
      refreshed.resolve()
    }
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
        <SequencerRecoveryControls worktreeId="r::/repo" operation="cherry-pick" disabled={false} />
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
    expect(invalidatedWorktree).toBe('r::/repo')
    expect(accepted).toEqual({ entries: [], head: 'host-B', conflictOperation: 'revert' })

    status.mockResolvedValue({
      entries: [],
      head: 'host-B-clean',
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: true, ahead: 99, behind: 0 }
    })
    continued.mockResolvedValue(undefined)
    await act(async () => useAppStore.setState({ activeWorktreeId: 'r::/repo' }))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await refreshed.promise
    })
    expect(requestedPublishTarget).toEqual({ remoteName: 'publish-b', branchName: 'topic-b' })
    expect(acceptedUpstream).toEqual({ hasUpstream: true, ahead: 2, behind: 0 })
  } finally {
    window.removeEventListener(GIT_GRAPH_REFRESH_EVENT, onGraphRefresh)
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(initial, true)
  }
})
