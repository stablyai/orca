// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useBranchSwitchOutcome } from './use-branch-switch-outcome'
import { useSourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import { useSourceControlStatusRefresh } from '../sync/use-status-refresh'
import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'
import type { SourceControlActionError } from '../sync/action-error'
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({ gitStatusByWorktree: {}, gitStatusReadErrorByWorktree: {} }))
  }
})
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/worktree-git-copy', () => ({
  useWorktreeGitCopyHostId: () => 'local',
  worktreeCopyPushTarget: () => undefined,
  resolveWorktreeGitCopyNow: (worktreeId: string) => ({
    worktreeId,
    hostId: 'local',
    transport: { kind: 'local' }
  })
}))
vi.mock('../sync/git-status-refresh', () => ({ refreshGitStatusForWorktree: vi.fn() }))
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

it('keeps a landed warning through clean refresh and navigation until the next same-worktree action', async () => {
  vi.mocked(refreshGitStatusForWorktree).mockImplementation(async ({ worktreeId }) => {
    useAppStore.setState((state) => ({
      gitStatusByWorktree: { ...state.gitStatusByWorktree, [worktreeId]: [] }
    }))
  })
  let rejectFetch: ((error: Error) => void) | undefined
  const fetchBranch = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFetch = reject
      })
  )
  function Probe({ active }: { active: string }) {
    const [errors, setErrors] = useState<Record<string, SourceControlActionError | null>>({})
    const sequences = useRef<Record<string, number>>({})
    const record = useBranchSwitchOutcome(setErrors, sequences)
    const { refreshActiveGitStatusAfterMutation } = useSourceControlStatusRefresh({
      activeRepoTarget: { kind: 'local' },
      activeWorktreeId: active,
      worktreePath: '/repo',
      isFolder: false,
      repositoryHuge: null,
      activeConnectionId: null
    })
    const { runRemoteAction } = useSourceControlRemoteActionRunner({
      activeRepoTarget: { kind: 'local' },
      activeWorktree: null,
      activeWorktreeId: active,
      branchName: 'main',
      effectiveBaseRef: null,
      worktreePath: '/repo',
      grouped: { staged: [], unstaged: [], untracked: [] },
      handleCommit: vi.fn(),
      fetchBranch,
      fastForwardBranch: vi.fn(),
      pullBranch: vi.fn(),
      pushBranch: vi.fn(),
      rebaseFromBase: vi.fn(),
      syncBranch: vi.fn(),
      remoteStatus: undefined,
      remoteStatusForActions: undefined,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef: { current: vi.fn() },
      refreshGitHistoryRef: { current: vi.fn() },
      remoteActionErrorSequenceByWorktreeRef: sequences,
      setRemoteActionErrors: setErrors
    })
    return (
      <>
        <button data-fetch onClick={() => void runRemoteAction('fetch')}>
          Fetch
        </button>
        <button
          data-switch
          onClick={() =>
            record(
              'original',
              'Switched with files left behind.',
              refreshActiveGitStatusAfterMutation
            )
          }
        >
          Switch finished
        </button>
        {errors[active] && <p role="alert">{errors[active]?.message}</p>}
      </>
    )
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Probe active="original" />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-fetch]')?.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-switch]')?.click())
    expect(refreshGitStatusForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'original' })
    )
    expect(useAppStore.getState().gitStatusByWorktree.original).toEqual([])
    expect(container.textContent).toContain('Switched with files left behind.')
    await act(async () => root.render(<Probe active="another" />))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => rejectFetch?.(new Error('old fetch failed')))
    fetchBranch.mockRejectedValueOnce(new Error('another fetch failed'))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-fetch]')?.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('another fetch failed')
    await act(async () => root.render(<Probe active="original" />))
    expect(container.textContent).toContain('Switched with files left behind.')
    expect(container.textContent).not.toContain('old fetch failed')
    await act(async () => useAppStore.setState({ gitStatusByWorktree: { original: [] } }))
    expect(container.textContent).toContain('Switched with files left behind.')
    fetchBranch.mockRejectedValueOnce(new Error('new fetch failed'))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-fetch]')?.click())
    expect(container.textContent).not.toContain('Switched with files left behind.')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('new fetch failed')
  } finally {
    await act(async () => root.unmount())
  }
})
