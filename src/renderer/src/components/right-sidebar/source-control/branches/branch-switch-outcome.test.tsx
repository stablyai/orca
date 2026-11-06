// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useBranchSwitchOutcome } from './use-branch-switch-outcome'
import { useSourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import type { SourceControlActionError } from '../sync/action-error'
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({ gitStatusByWorktree: {}, gitStatusReadErrorByWorktree: {} }))
  }
})
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

it('keeps a landed warning over an older Fetch failure, across navigation, until clean status arrives', async () => {
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
    const { runRemoteAction } = useSourceControlRemoteActionRunner({
      activeRepoTarget: { kind: 'local' },
      activeWorktree: undefined,
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
      refreshActiveGitStatusAfterMutation: vi.fn(),
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
        <button data-switch onClick={() => record('original', 'Switched with files left behind.')}>
          Switch finished
        </button>
        <p>{errors.original?.message}</p>
      </>
    )
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Probe active="original" />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-fetch]')?.click())
    await act(async () => root.render(<Probe active="another" />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-switch]')?.click())
    await act(async () => rejectFetch?.(new Error('old fetch failed')))
    expect(container.textContent).toContain('Switched with files left behind.')
    expect(container.textContent).not.toContain('old fetch failed')
    await act(async () => root.render(<Probe active="original" />))
    fetchBranch.mockResolvedValueOnce(undefined)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-fetch]')?.click())
    expect(container.textContent).not.toContain('Switched with files left behind.')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-switch]')?.click())
    expect(container.textContent).toContain('Switched with files left behind.')
    await act(async () => useAppStore.setState({ gitStatusByWorktree: { original: [] } }))
    expect(container.textContent).not.toContain('Switched with files left behind.')
  } finally {
    await act(async () => root.unmount())
  }
})
