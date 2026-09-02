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

  it('stores upstream status per worktree', () => {
    const store = createEditorStore()

    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })

    expect(store.getState().remoteStatusesByWorktree['wt-1']).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })
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

  it('runs pull and refreshes status + upstream on success', async () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]
    })

    await store.getState().pullBranch('wt-1', '/repo')

    expect(gitPullMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('routes git operations through the explicit runtime owner instead of ambient focus', async () => {
    const store = createEditorStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    await store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
      runtimeTargetSettings: { activeRuntimeEnvironmentId: null }
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

  it('runs rebase from base and refreshes upstream on success', async () => {
    const store = createEditorStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await store.getState().rebaseFromBase('wt-1', '/repo', 'origin/main', undefined, pushTarget)

    expect(gitRebaseFromBaseMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      baseRef: 'origin/main',
      connectionId: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('runs fast-forward and refreshes upstream on success', async () => {
    const store = createEditorStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await store.getState().fastForwardBranch('wt-1', '/repo', undefined, pushTarget)

    expect(gitFastForwardMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1',
      pushTarget
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a fast-forward toast and clears the busy flag when fast-forward fails', async () => {
    const store = createEditorStore()
    gitFastForwardMock.mockRejectedValueOnce(new Error('Not possible to fast-forward, aborting.'))

    await expect(store.getState().fastForwardBranch('wt-1', '/repo')).rejects.toThrow(
      'Not possible to fast-forward'
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Fast-forward failed. Not possible to fast-forward, aborting.'
    )
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('keeps fast-forward wording when normalized pull errors report local changes', async () => {
    const store = createEditorStore()
    gitFastForwardMock.mockRejectedValueOnce(
      new Error(
        'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
      )
    )

    await expect(store.getState().fastForwardBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Fast-forward blocked — commit or stash your local changes first.'
    )
  })

  it('keeps fast-forward wording when normalized pull errors report untracked files', async () => {
    const store = createEditorStore()
    gitFastForwardMock.mockRejectedValueOnce(
      new Error('Pull would overwrite untracked files. Move, remove, or add them before pulling.')
    )

    await expect(store.getState().fastForwardBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Fast-forward blocked — move, remove, or add untracked files first.'
    )
  })

  it('keeps rebase wording when normalized pull errors report local changes', async () => {
    const store = createEditorStore()
    gitRebaseFromBaseMock.mockRejectedValueOnce(
      new Error(
        'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
      )
    )

    await expect(store.getState().rebaseFromBase('wt-1', '/repo', 'origin/main')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Rebase blocked — commit or stash your local changes first.'
    )
  })

  it('keeps rebase wording when normalized pull errors report untracked files', async () => {
    const store = createEditorStore()
    gitRebaseFromBaseMock.mockRejectedValueOnce(
      new Error('Pull would overwrite untracked files. Move, remove, or add them before pulling.')
    )

    await expect(store.getState().rebaseFromBase('wt-1', '/repo', 'origin/main')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Rebase blocked — move, remove, or add untracked files first.'
    )
  })

  it('fetches the explicit push target and refreshes that target status', async () => {
    const store = createEditorStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await store.getState().fetchBranch('wt-1', '/repo', undefined, pushTarget)

    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1',
      pushTarget
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces a readable toast when pull reports local changes would be overwritten', async () => {
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.ts\nPlease commit your changes or stash them before you merge.\nAborting'
      )
    )

    await expect(store.getState().pullBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Pull blocked — commit or stash your local changes first.'
    )
  })

  it('surfaces an explicit toast when pull stops on merge conflicts', async () => {
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.'
      )
    )

    await expect(store.getState().pullBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Pull stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
    )
  })

  it('runs publish branch through push with publish=true', async () => {
    // Why: pushBranch no longer awaits a post-op git status / upstream
    // refresh. The 3s git-status poll and the upstream-status effect in the
    // sidebar reconcile state shortly after the IPC returns; keeping the
    // mutation tight stops compound flows from stalling between commit and
    // push.
    const store = createEditorStore()

    await store.getState().pushBranch('wt-1', '/repo', true)

    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      publish: true,
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
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

  it('maps publish updates-were-rejected into a clean actionable toast', async () => {
    const store = createEditorStore()
    const publishError = new Error(
      'Updates were rejected because the tip of your current branch is behind its remote counterpart.'
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

  it('maps raw publish wrapper errors into a cleaner actionable toast', async () => {
    const store = createEditorStore()
    const rawPublishError = new Error(
      'git push failed: Command failed: git push --set-upstream origin feature-branch\nremote: Repository not found.\nfatal: Authentication failed for https://github.com/acme/private-repo.git'
    )
    gitPushMock.mockRejectedValueOnce(rawPublishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      rawPublishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Publish Branch failed. Authentication failed for https://github.com/acme/private-repo.git. Check your remote access and try again.'
    )
  })

  it('uses a fallback message for generic publish errors', async () => {
    const store = createEditorStore()
    const publishError = new Error('error: RPC failed; curl 56 GnuTLS recv error')
    gitPushMock.mockRejectedValueOnce(publishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      publishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Publish Branch failed. Check your remote access and try again.'
    )
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('maps non-fast-forward push errors into a clean actionable toast', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      'Updates were rejected because the tip of your current branch is behind its remote counterpart.'
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
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

  it('maps non-fast-forward keyword push errors into a clean actionable toast', async () => {
    const store = createEditorStore()
    const pushError = new Error('Push rejected: remote has newer commits (non-fast-forward).')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
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

  it('surfaces submodule push failures with the submodule name', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "Command failed: git push\nPushing submodule 'find-cmux-followers'\n" +
        ' ! [rejected]        master -> master (fetch first)\n' +
        "Unable to push submodule 'find-cmux-followers'\n" +
        'fatal: failed to push all needed submodules'
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      "Push failed. Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
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

  it('surfaces transport-prefixed normalized submodule push failures', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "Error invoking remote method 'git:push': Error: Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      "Push failed. Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
    )
    await flushAsyncRemoteRefresh()

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

  it('maps pre-push hook failures to hook-specific guidance instead of remote access', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "git push failed: Command failed: git push origin main\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1\neslint found 2 errors"
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith('Push blocked — lint failed during push.')
  })

  it('uses a fallback message for generic push errors', async () => {
    const store = createEditorStore()
    const pushError = new Error('network timeout')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith('Push failed. Check your connection and try again.')
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('maps force-with-lease rejection into force-push guidance', async () => {
    const store = createEditorStore()
    const pushError = new Error('fatal: stale info')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(
      store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
        forceWithLease: true
      })
    ).rejects.toThrow(pushError.message)

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    )
    await flushAsyncRemoteRefresh()

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

  it('uses a force-push fallback message for generic force-with-lease errors', async () => {
    const store = createEditorStore()
    const pushError = new Error('network timeout')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(
      store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
        forceWithLease: true
      })
    ).rejects.toThrow(pushError.message)

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Force Push failed. Check your connection and try again.'
    )
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('uses a fallback remote failure message when push rejects without Error', async () => {
    const store = createEditorStore()
    gitPushMock.mockRejectedValueOnce('failure')

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toBe('failure')

    expect(toastErrorMock).toHaveBeenCalledWith('Remote operation failed')
  })

  it('runs fetchBranch and clears the busy flag on success', async () => {
    // Why: fetchBranch no longer awaits a post-op upstream refresh.
    // useGitStatusPolling and the sidebar's upstream effect handle the
    // reconcile, keeping the mutation focused on the single IPC.
    const store = createEditorStore()
    await store.getState().fetchBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
    expect(toastErrorMock).not.toHaveBeenCalled()
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
    // Why: a transient upstream fetch failure (network blip, auth prompt
    // timeout) must not erase the last-known ahead/behind counts — doing so
    // would briefly flip the UI to an unknown/no-upstream state that
    // misrepresents the branch's relationship to its remote.
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
    // Why: a bare boolean races across worktrees — if push A finishes while
    // pull B is still running, flipping the flag off would prematurely
    // re-enable B's button. The refcount-derived boolean must stay true
    // until every in-flight remote op has finished.
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

    const pushA = store.getState().pushBranch('wt-1', '/a')
    // Kick microtasks so pushA has begun and flipped the flag on.
    await Promise.resolve()
    expect(store.getState().isRemoteOperationActive).toBe(true)

    const pushB = store.getState().pushBranch('wt-2', '/b')
    await Promise.resolve()
    expect(store.getState().isRemoteOperationActive).toBe(true)

    resolveA()
    await pushA.catch(() => {})
    // B is still running, so the busy flag must remain true.
    expect(store.getState().isRemoteOperationActive).toBe(true)

    resolveB()
    await pushB.catch(() => {})
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('runs syncBranch end-to-end (fetch+pull+push) on success', async () => {
    // Why: syncBranch no longer awaits a post-op git status / upstream
    // refresh. The polling layer reconciles state after the mutation
    // returns; the in-mutation upstream-status read remains because it
    // gates whether the inner push stage runs.
    const store = createEditorStore()

    await store.getState().syncBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    expect(gitPullMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    // ahead=1 in the default mock, so sync pushes.
    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      worktreeId: 'wt-1'
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('skips the inner push when syncBranch sees ahead=0', async () => {
    // Why: guards against a no-op push round-trip after a pure fast-forward
    // pull. See syncBranch's ahead>0 guard in editor.ts.
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

  it('surfaces a sync-labeled toast when syncBranch inner push fails with auth error', async () => {
    // Why: the user invoked Sync — the toast must read "Sync failed..." even
    // though the underlying step is push. Detail extraction still surfaces
    // the actionable fatal/remote line so auth/protected-branch reasons stay
    // visible.
    const store = createEditorStore()
    const authError = new Error(
      'git push failed: Command failed: git push origin feature\nremote: Repository not found.\nfatal: Authentication failed for https://github.com/acme/private-repo.git'
    )
    gitPushMock.mockRejectedValueOnce(authError)

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow(authError.message)

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Sync failed. Authentication failed for https://github.com/acme/private-repo.git. Check your remote access and try again.'
    )
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a single sync-labeled toast when syncBranch inner push is non-fast-forward', async () => {
    // Why: under sync, NFF means the remote raced ahead between fetch and
    // push — sync just pulled, so the bare "Pull first" guidance is wrong.
    // Surface a sync-shaped retry hint instead.
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
    // Why: failures in sync's fetch/pull/status stages flow through the
    // outer catch's generic path; push-specific framing only applies to
    // the inner push stage.
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
