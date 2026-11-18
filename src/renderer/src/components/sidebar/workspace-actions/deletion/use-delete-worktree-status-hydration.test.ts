// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  GitStatusEntry,
  GitStatusResult
} from '../../../../../../shared/git/status/git-status-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { makeWorktree } from '../../../../store/slices/worktrees/worktree.test-fixture'
import { useDeleteWorktreeDirtyChanges } from './use-delete-worktree-dirty-changes'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'

const mocks = vi.hoisted(() => ({ getRuntimeGitStatus: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitStatus: mocks.getRuntimeGitStatus
}))
vi.mock('@/lib/workspace/ownership/resolve-owner', () => ({
  runtimeTargetForWorkspaceOwner: () => ({ kind: 'local' })
}))

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  mocks.getRuntimeGitStatus.mockReset()
  useAppStore.setState(initialState, true)
})

const target = makeWorktree({
  id: 'repo-1::/work/feature',
  repoId: 'repo-1',
  path: '/work/feature'
})
const repoMap = new Map<string, Repo>()
const dirtyEntry: GitStatusEntry = { path: 'notes.md', status: 'modified', area: 'unstaged' }

function renderDialogChecks(): () => { checkState: string | undefined; changeCount: number } {
  const { result } = renderHook(() => {
    const gitStatusByWorktreeIdentity = useDeleteWorktreeStatusHydration({
      isOpen: true,
      deleteTargets: [target],
      visibleTargets: [target],
      repoMap
    })
    const { checkStates, counts } = useDeleteWorktreeDirtyChanges({
      deleteTargets: [target],
      gitStatusByWorktreeIdentity,
      deleteStateByWorktreeId: {},
      repoMap
    })
    return { checkState: checkStates.get(target.id), changeCount: counts.get(target.id) ?? 0 }
  })
  return () => result.current
}

it('reports a git status that resolved with readError as unavailable, not clean', async () => {
  mocks.getRuntimeGitStatus.mockResolvedValue({
    entries: [],
    conflictOperation: 'unknown',
    readError: 'fatal: not a git repository'
  } satisfies GitStatusResult)
  const checks = renderDialogChecks()
  await waitFor(() => expect(checks().checkState).not.toBe('checking'))
  expect(checks().checkState).toBe('unavailable')
})

it('rechecks instead of trusting entries the store kept after a failed refresh', async () => {
  useAppStore.setState({
    gitStatusByWorktree: { [target.id]: [] },
    gitStatusReadErrorByWorktree: { [target.id]: 'fatal: index file corrupt' }
  })
  let resolveStatus: (status: GitStatusResult) => void = () => {}
  mocks.getRuntimeGitStatus.mockReturnValue(
    new Promise<GitStatusResult>((resolve) => {
      resolveStatus = resolve
    })
  )
  const checks = renderDialogChecks()
  expect(checks().checkState).toBe('checking')

  resolveStatus({ entries: [dirtyEntry], conflictOperation: 'unknown' })
  await waitFor(() => expect(checks().checkState).toBe('complete'))
  expect(checks().changeCount).toBe(1)
})
