// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
  allowLocalWindowsWslAliases?: true
}

const subscriptionState = vi.hoisted(() => ({
  snapshot: { targets: [] as TestWatchTarget[], targetsKey: '' },
  subscribeRuntimeFileChanges: vi.fn(),
  disposeEventHandler: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  subscribeRuntimeFileChanges: subscriptionState.subscribeRuntimeFileChanges
}))
vi.mock('./editor-external-watch-targets', () => ({
  selectEditorExternalWatchTargets: () => subscriptionState.snapshot,
  getEditorExternalWatchTargetKey: (target: TestWatchTarget) =>
    [
      target.worktreeId,
      target.worktreePath,
      target.connectionId ?? 'local',
      target.runtimeEnvironmentId ?? 'client',
      target.allowLocalWindowsWslAliases ? 'wsl-aliases' : 'literal'
    ].join('::')
}))
vi.mock('./editor-external-watch-event-reconciliation', () => ({
  buildEditorExternalWatchEventHandler: vi.fn(() => ({
    handleFsChanged: vi.fn(),
    dispose: subscriptionState.disposeEventHandler
  })),
  collectOverflowEditorExternalReloadTargets: vi.fn()
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  verifyLatchedEditorMoveDestinations: vi.fn()
}))

import { useEditorExternalWatch } from './useEditorExternalWatch'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

function runtimeTarget(): TestWatchTarget {
  return {
    worktreeId: 'wt-runtime',
    worktreePath: '/runtime/repo',
    connectionId: 'nested-ssh',
    runtimeEnvironmentId: 'runtime-1'
  }
}

function deferredRuntimeSubscription(): {
  promise: Promise<() => void>
  resolve: (unsubscribe: () => void) => void
} {
  let resolve!: (unsubscribe: () => void) => void
  const promise = new Promise<() => void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('useEditorExternalWatch subscriptions', () => {
  let previousApi: unknown
  let container: HTMLDivElement
  let root: Root
  let watchWorktree: ReturnType<typeof vi.fn>
  let unwatchWorktree: ReturnType<typeof vi.fn>
  let unsubscribeFsEvents: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    subscriptionState.snapshot = { targets: [], targetsKey: '' }
    watchWorktree = vi.fn().mockResolvedValue(undefined)
    unwatchWorktree = vi.fn().mockResolvedValue(undefined)
    unsubscribeFsEvents = vi.fn()
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: {
        watchWorktree,
        unwatchWorktree,
        onFsChanged: vi.fn(() => unsubscribeFsEvents)
      }
    }
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  it('unsubscribes an SSH watch and the shared event listener exactly once on unmount', async () => {
    subscriptionState.snapshot = {
      targets: [
        {
          worktreeId: 'wt-ssh',
          worktreePath: '/remote/repo',
          connectionId: 'ssh-1',
          runtimeEnvironmentId: null
        }
      ],
      targetsKey: 'ssh-watch'
    }
    await act(async () => root.render(createElement(WatchProbe)))

    expect(watchWorktree).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1'
    })
    await act(async () => root.unmount())

    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1'
    })
    expect(unsubscribeFsEvents).toHaveBeenCalledTimes(1)
    expect(subscriptionState.disposeEventHandler).toHaveBeenCalledTimes(1)
  })

  it('keeps a shared local folder watched until its last editor owner closes', async () => {
    const project = { ...runtimeTarget(), runtimeEnvironmentId: null, connectionId: undefined }
    const floating = { ...project, worktreeId: 'global-floating-terminal' }
    subscriptionState.snapshot = { targets: [project, floating], targetsKey: 'both' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(watchWorktree).toHaveBeenCalledTimes(1)

    subscriptionState.snapshot = { targets: [floating], targetsKey: 'floating-only' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(unwatchWorktree).not.toHaveBeenCalled()
    expect(watchWorktree).toHaveBeenCalledTimes(1)

    subscriptionState.snapshot = { targets: [], targetsKey: '' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
  })

  it('routes shared paths only to owners on the event connection', async () => {
    const base = { ...runtimeTarget(), runtimeEnvironmentId: null }
    const local = { ...base, worktreeId: 'project', connectionId: undefined }
    const floating = { ...local, worktreeId: 'global-floating-terminal' }
    const first = { ...base, worktreeId: 'ssh-a', connectionId: 'ssh-a' }
    const second = { ...base, worktreeId: 'ssh-b', connectionId: 'ssh-b' }
    subscriptionState.snapshot = { targets: [floating, first, local, second], targetsKey: 'mixed' }
    await act(async () => root.render(createElement(WatchProbe)))
    const findTargets = vi.mocked(buildEditorExternalWatchEventHandler).mock.calls[0][0]
    expect(findTargets(base.worktreePath, null, undefined)).toEqual([floating, local])
    expect(findTargets(base.worktreePath, null, 'ssh-a')).toEqual([first])
    expect(findTargets(base.worktreePath, null, 'ssh-b')).toEqual([second])
    expect(findTargets(base.worktreePath, null, 'unknown')).toEqual([])
  })

  it('retains subscription ownership when a paired runtime omits the connection field', async () => {
    subscriptionState.subscribeRuntimeFileChanges.mockResolvedValue(vi.fn())
    const target = runtimeTarget()
    subscriptionState.snapshot = { targets: [target], targetsKey: 'legacy-runtime' }
    await act(async () => root.render(createElement(WatchProbe)))
    const callback = subscriptionState.subscribeRuntimeFileChanges.mock.calls[0][1]
    const payload = { worktreePath: target.worktreePath, events: [] }
    callback(payload)
    const handler = vi.mocked(buildEditorExternalWatchEventHandler).mock.results[0].value
    expect(handler.handleFsChanged).toHaveBeenCalledWith(
      { ...payload, connectionId: target.connectionId },
      target.runtimeEnvironmentId
    )
  })

  it('moves a floating subscription while retaining the project subscription', async () => {
    const project = { ...runtimeTarget(), runtimeEnvironmentId: null, connectionId: undefined }
    const floating = { ...project, worktreeId: 'global-floating-terminal' }
    subscriptionState.snapshot = { targets: [project, floating], targetsKey: 'original' }
    await act(async () => root.render(createElement(WatchProbe)))
    const moved = { ...floating, worktreePath: '/other' }
    subscriptionState.snapshot = { targets: [project, moved], targetsKey: 'moved' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(watchWorktree).toHaveBeenCalledTimes(2)
    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/other',
      connectionId: undefined
    })
    expect(unwatchWorktree).not.toHaveBeenCalled()
    subscriptionState.snapshot = { targets: [project], targetsKey: 'closed' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(unwatchWorktree).toHaveBeenCalledExactlyOnceWith({
      worktreePath: '/other',
      connectionId: undefined
    })
  })

  it('disposes a runtime subscription that resolves after unmount', async () => {
    const pending = deferredRuntimeSubscription()
    const unsubscribeRuntime = vi.fn()
    subscriptionState.subscribeRuntimeFileChanges.mockReturnValueOnce(pending.promise)
    subscriptionState.snapshot = {
      targets: [runtimeTarget()],
      targetsKey: 'runtime-watch'
    }
    await act(async () => root.render(createElement(WatchProbe)))
    await act(async () => root.unmount())

    pending.resolve(unsubscribeRuntime)
    await act(async () => pending.promise)

    expect(unsubscribeRuntime).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).not.toHaveBeenCalled()
  })

  it('cannot let an old runtime subscribe resolution replace a re-added watch', async () => {
    const stalePending = deferredRuntimeSubscription()
    const currentPending = deferredRuntimeSubscription()
    const unsubscribeStale = vi.fn()
    const unsubscribeCurrent = vi.fn()
    subscriptionState.subscribeRuntimeFileChanges
      .mockReturnValueOnce(stalePending.promise)
      .mockReturnValueOnce(currentPending.promise)
    subscriptionState.snapshot = {
      targets: [runtimeTarget()],
      targetsKey: 'runtime-watch-1'
    }
    await act(async () => root.render(createElement(WatchProbe)))

    subscriptionState.snapshot = { targets: [], targetsKey: 'no-runtime-watch' }
    await act(async () => root.render(createElement(WatchProbe)))
    subscriptionState.snapshot = {
      targets: [runtimeTarget()],
      targetsKey: 'runtime-watch-2'
    }
    await act(async () => root.render(createElement(WatchProbe)))

    currentPending.resolve(unsubscribeCurrent)
    await act(async () => currentPending.promise)
    stalePending.resolve(unsubscribeStale)
    await act(async () => stalePending.promise)
    expect(unsubscribeStale).toHaveBeenCalledTimes(1)
    expect(unsubscribeCurrent).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    expect(unsubscribeCurrent).toHaveBeenCalledTimes(1)
  })
})
