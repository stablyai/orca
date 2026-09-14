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
