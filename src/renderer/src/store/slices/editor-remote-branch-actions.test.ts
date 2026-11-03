import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import { isSyncPushStageError } from '@/lib/source-control-remote-error'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice remote branch actions', () => {
  const gitStatusMock = vi.fn()
  const gitUpstreamStatusMock = vi.fn()
  const gitPushMock = vi.fn()
  const gitPullMock = vi.fn()
  const gitFastForwardMock = vi.fn()
  const gitRebaseFromBaseMock = vi.fn()
  const gitFetchMock = vi.fn()

  beforeEach(() => {
    toastErrorMock.mockReset()
    gitStatusMock.mockReset()
    gitUpstreamStatusMock.mockReset()
    gitPushMock.mockReset()
    gitPullMock.mockReset()
    gitFastForwardMock.mockReset()
    gitRebaseFromBaseMock.mockReset()
    gitFetchMock.mockReset()

    gitStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    gitUpstreamStatusMock.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 1,
      behind: 0
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window.api = {
      git: {
        status: gitStatusMock,
        upstreamStatus: gitUpstreamStatusMock,
        push: gitPushMock,
        pull: gitPullMock,
        fastForward: gitFastForwardMock,
        rebaseFromBase: gitRebaseFromBaseMock,
        fetch: gitFetchMock
      }
    }
  })

  it('refuses a git operation whose worktree no row places, instead of using the focused server', async () => {
    const store = createEditorStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    await expect(store.getState().pushBranch('wt-unknown', '/elsewhere')).rejects.toThrow(
      'The workspace host is unresolved'
    )

    expect(gitPushMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a toast and clears the busy flag when fetch fails', async () => {
    const store = createEditorStore()
    gitFetchMock.mockRejectedValueOnce(new Error('network timeout'))

    await expect(store.getState().fetchBranch('wt-1', '/repo')).rejects.toThrow('network timeout')

    expect(toastErrorMock).toHaveBeenCalledWith('Fetch failed. network timeout')
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('preserves prior upstream status when fetch fails', async () => {
    // Transient upstream failures retain known ahead/behind counts instead of flashing unknown/no-upstream state.
    const store = createEditorStore()
    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })
    gitUpstreamStatusMock.mockRejectedValueOnce(new Error('transient failure'))

    await store.getState().fetchUpstreamStatus('wt-1', '/repo')

    expect(store.getState().remoteStatusesByWorktree['wt-1']).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })
  })

  it('keeps isRemoteOperationActive true while any remote op is in flight', async () => {
    // Refcount remote operations across worktrees; push A settling must not reenable still-running pull B.
    const store = createEditorStore()

    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    gitPushMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveB = resolve
          })
      )

    const pushA = store.getState().pushBranch('wt-1', '/a', true)
    // Kick microtasks so pushA has begun and flipped the flag on.
    await Promise.resolve()
    expect(store.getState().isRemoteOperationActive).toBe(true)

    const pushB = store.getState().pushBranch('wt-2', '/b', false, undefined, undefined, {
      runtimeTarget: { kind: 'local' }
    })
    await Promise.resolve()
    expect(store.getState().isRemoteOperationActive).toBe(true)

    expect(store.getState().remoteOperations).toEqual([
      { worktreeId: 'wt-1', kind: 'publish' },
      { worktreeId: 'wt-2', kind: 'push' }
    ])
    resolveA()
    await pushA.catch(() => {})
    expect(store.getState().remoteOperations).toEqual([{ worktreeId: 'wt-2', kind: 'push' }])
    // B is still running, so the busy flag must remain true.
    expect(store.getState().isRemoteOperationActive).toBe(true)

    resolveB()
    await pushB.catch(() => {})
    expect(store.getState().remoteOperations).toEqual([])
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it.each(['publish', 'fetch'] as const)(
    'keeps the remaining operation when %s finishes first in the same workspace',
    async (firstToFinish) => {
      const store = createEditorStore()
      let finishPublish: () => void = () => {}
      let finishFetch: () => void = () => {}
      gitPushMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPublish = resolve
          })
      )
      gitFetchMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFetch = resolve
          })
      )
      const publishing = store.getState().pushBranch('wt-1', '/repo', true)
      const fetching = store.getState().fetchBranch('wt-1', '/repo')

      if (firstToFinish === 'publish') {
        finishPublish()
        await publishing
      } else {
        finishFetch()
        await fetching
      }
      expect(store.getState().isRemoteOperationActive).toBe(true)
      expect(store.getState().remoteOperations).toEqual([
        { worktreeId: 'wt-1', kind: firstToFinish === 'publish' ? 'fetch' : 'publish' }
      ])

      finishPublish()
      finishFetch()
      await Promise.all([publishing, fetching])
      expect(store.getState().remoteOperations).toEqual([])
      expect(store.getState().isRemoteOperationActive).toBe(false)
    }
  )

  it('marks syncBranch inner push hook failures as sync push-stage failures', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "git push failed: Command failed: git push origin feature\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1"
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    let thrown: unknown
    try {
      await store.getState().syncBranch('wt-1', '/repo')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(pushError)
    expect(isSyncPushStageError(thrown)).toBe(true)
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('Sync blocked — pre-push hook failed.')
  })

  it('does not classify syncBranch fetch-stage hook-looking failures as push blocked', async () => {
    const store = createEditorStore()
    gitFetchMock.mockRejectedValueOnce(
      new Error('fetch failed before push\npre-push hook docs mention eslint')
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('Sync failed. Check your connection and try again.')
    expect(gitPushMock).not.toHaveBeenCalled()
  })
})
