import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createEditorStore, flushAsyncRemoteRefresh } from './editor-slice-test-harness'
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

  it('does not notify subscribers when upstream status is unchanged', () => {
    const store = createEditorStore()
    const status = {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    }

    store.getState().setUpstreamStatus('wt-1', status)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.getState().setUpstreamStatus('wt-1', { ...status })
    unsubscribe()

    expect(listener).not.toHaveBeenCalled()
  })

  it('updates subscribers when explicit upstream status adds patch equivalence', () => {
    const store = createEditorStore()
    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3
    })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
    unsubscribe()

    expect(listener).toHaveBeenCalled()
    expect(store.getState().remoteStatusesByWorktree['wt-1']).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
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

  it('routes git operations through the explicit runtime owner instead of ambient focus', async () => {
    const store = createEditorStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    await store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
      runtimeTarget: { kind: 'local' }
    })

    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      publish: false,
      connectionId: undefined,
      worktreeId: 'wt-1',
      pushTarget: undefined,
      forceWithLease: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget: undefined
    })
  })

  it('preserves actionable publish errors and refreshes upstream after rejection', async () => {
    const store = createEditorStore()
    const publishError = new Error(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
    gitPushMock.mockRejectedValueOnce(publishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      publishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    await flushAsyncRemoteRefresh()

    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
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

  it('skips the inner push when syncBranch sees ahead=0', async () => {
    // Require ahead>0 guard to avoid no-op push after pure fast-forward pull.
    const store = createEditorStore()
    gitUpstreamStatusMock
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 0,
        behind: 1
      })
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 0,
        behind: 0
      })

    await store.getState().syncBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalled()
    expect(gitPullMock).toHaveBeenCalled()
    expect(gitPushMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('force-pushes with lease instead of pulling when sync sees a stale rebased upstream', async () => {
    const store = createEditorStore()
    gitUpstreamStatusMock.mockResolvedValueOnce({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })

    await store.getState().syncBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalled()
    expect(gitPullMock).not.toHaveBeenCalled()
    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1',
      forceWithLease: true
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledTimes(2)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces a single sync-labeled toast when syncBranch inner push is non-fast-forward', async () => {
    // NFF after sync pull means remote raced ahead; offer sync retry rather than stale Pull first guidance.
    const store = createEditorStore()
    const pushError = new Error(
      'Updates were rejected because the tip of your current branch is behind its remote counterpart.'
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow(pushError.message)

    // No double-toast from the outer catch.
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Sync failed — remote moved while syncing. Try again.'
    )
  })

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

  it('does not classify syncBranch upstream-status hook-looking failures as push blocked', async () => {
    const store = createEditorStore()
    gitUpstreamStatusMock.mockRejectedValueOnce(
      new Error('upstream status failed before push\npre-push hook docs mention eslint')
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('Sync failed. Check your connection and try again.')
    expect(gitPushMock).not.toHaveBeenCalled()
  })

  it('surfaces the pull-blocked toast when syncBranch pull stage fails', async () => {
    // Outer fetch/pull/status failures use generic sync catch; push-specific wording applies only to inner push.
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.ts\nPlease commit your changes or stash them before you merge.\nAborting'
      )
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Pull blocked — commit or stash your local changes first.'
    )
    expect(gitPushMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a sync-labeled toast when syncBranch stops on merge conflicts', async () => {
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.'
      )
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Sync stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
    )
    expect(gitPushMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })
})
