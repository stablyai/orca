// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorktreeOperationStore } from '../panel/worktree-operation-store'
import { useSourceControlRemoteActionRunner } from './use-remote-action-runner'

vi.mock('./remote-refresh', () => ({
  refreshSourceControlAfterRemoteAction: vi.fn(),
  resolveRemoteActionError: () => 'Push failed'
}))

const MARKER = { branch: 'feature', upstreamOid: 'upstream-1', state: 'done' as const }

afterEach(() => {
  cleanup()
})

function renderRunner(
  worktreeId: string,
  actions: { pushBranch?: () => Promise<void>; rebaseFromBase?: () => Promise<unknown> }
) {
  const operationStore = getWorktreeOperationStore(worktreeId, 'local', 'instance-1')
  operationStore.setState({ orcaRebase: MARKER })
  const noop = vi.fn(async () => {})
  const { result } = renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; every field is stubbed, but vi.fn stubs are looser than the store action signatures.
    useSourceControlRemoteActionRunner({
      activeRepoTarget: { kind: 'local' },
      activeWorktree: null,
      activeWorktreeId: worktreeId,
      branchName: 'feature',
      effectiveBaseRef: 'origin/main',
      fastForwardBranch: noop,
      fetchBranch: noop,
      grouped: { staged: [], unstaged: [], untracked: [] },
      handleCommit: vi.fn(async () => true),
      operationStore,
      pullBranch: noop,
      pushBranch: actions.pushBranch ?? noop,
      rebaseFromBase: actions.rebaseFromBase ?? noop,
      refreshActiveGitStatusAfterMutation: noop,
      refreshBranchCompareRef: { current: noop },
      refreshGitHistoryRef: { current: noop },
      remoteStatus: undefined,
      remoteStatusForActions: undefined,
      syncBranch: noop,
      worktreePath: `/repo/${worktreeId}`
    } as unknown as Parameters<typeof useSourceControlRemoteActionRunner>[0])
  )
  return { operationStore, runRemoteAction: result.current.runRemoteAction }
}

it('keeps the post-rebase marker when the push is rejected, and retires it once one lands', async () => {
  const rejected = renderRunner('wt-push-rejected', {
    pushBranch: vi.fn(async () => {
      throw new Error('rejected')
    })
  })
  await expect(rejected.runRemoteAction('push')).resolves.toMatchObject({ status: 'failed' })
  expect(rejected.operationStore.getState().orcaRebase).toEqual(MARKER)

  const landed = renderRunner('wt-push-landed', {})
  await expect(landed.runRemoteAction('push')).resolves.toEqual({ status: 'ok' })
  expect(landed.operationStore.getState().orcaRebase).toBeNull()
})

it("leaves the active worktree's marker alone when the rebase targets another worktree", async () => {
  const { operationStore, runRemoteAction } = renderRunner('wt-active', {
    rebaseFromBase: vi.fn(async () => ({ integratedUpstreamOid: 'upstream-2' }))
  })
  await runRemoteAction('rebase', {
    target: { target: { kind: 'local' }, worktreeId: 'wt-other', worktreePath: '/repo/wt-other' }
  })
  expect(operationStore.getState().orcaRebase).toEqual(MARKER)
})
