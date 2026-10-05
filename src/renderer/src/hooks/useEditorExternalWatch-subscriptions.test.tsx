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
  shallow?: true
}

const subscriptionState = vi.hoisted(() => ({
  snapshot: { targets: [] as TestWatchTarget[], targetsKey: '' },
  subscribeRuntimeFileChanges: vi.fn(),
  handleFsChanged: vi.fn(),
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
    handleFsChanged: subscriptionState.handleFsChanged,
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

  it('keeps local shallow and recursive subscriptions at the same path isolated', async () => {
    const recursive: TestWatchTarget = {
      worktreeId: 'workspace',
      worktreePath: '/shared',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const shallow: TestWatchTarget = { ...recursive, worktreeId: 'floating', shallow: true }
    subscriptionState.snapshot = { targets: [recursive, shallow], targetsKey: 'two-scopes' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(watchWorktree).toHaveBeenCalledTimes(2)
    expect(watchWorktree).toHaveBeenCalledWith({
      worktreePath: '/shared',
      connectionId: undefined,
      shallow: true
    })
    const findTargets = vi.mocked(buildEditorExternalWatchEventHandler).mock.calls[0]?.[0]
    expect(findTargets?.('/shared', null, undefined, undefined, true)).toEqual([shallow])
    expect(findTargets?.('/shared', null)).toEqual([recursive])
    subscriptionState.snapshot = { targets: [recursive], targetsKey: 'recursive-only' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(unwatchWorktree).toHaveBeenCalledExactlyOnceWith({
      worktreePath: '/shared',
      connectionId: undefined,
      shallow: true
    })
    expect(watchWorktree).toHaveBeenCalledTimes(2)
  })

  it.each(['first', 'second'])(
    'keeps a shared watch after removing the %s owner',
    async (removedOwner) => {
      const targets: TestWatchTarget[] = ['first', 'second'].map((worktreeId) => ({
        worktreeId,
        worktreePath: '/shared',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }))
      subscriptionState.snapshot = { targets, targetsKey: 'both-owners' }
      await act(async () => root.render(createElement(WatchProbe)))
      expect(watchWorktree).toHaveBeenCalledTimes(1)

      subscriptionState.snapshot = {
        targets: targets.filter((target) => target.worktreeId !== removedOwner),
        targetsKey: 'one-owner'
      }
      await act(async () => root.render(createElement(WatchProbe)))
      expect(unwatchWorktree).not.toHaveBeenCalled()
      expect(watchWorktree).toHaveBeenCalledTimes(1)
      await act(async () => root.unmount())
      expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    }
  )

  it('routes shared-root events to every owner on the emitting host', async () => {
    const targets: TestWatchTarget[] = [
      {
        worktreeId: 'local-a',
        worktreePath: '/shared',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'local-b',
        worktreePath: '/shared',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'ssh-a',
        worktreePath: '/shared',
        connectionId: 'host-a',
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'ssh-b',
        worktreePath: '/shared',
        connectionId: 'host-b',
        runtimeEnvironmentId: null
      }
    ]
    subscriptionState.snapshot = { targets, targetsKey: 'shared-hosts' }
    await act(async () => root.render(createElement(WatchProbe)))
    const lookup = vi.mocked(buildEditorExternalWatchEventHandler).mock.calls[0][0]
    expect(lookup('/shared', null)).toEqual(targets.slice(0, 2))
    expect(lookup('/shared', null, 'host-a')).toEqual([targets[2]])
    expect(lookup('/shared', null, 'host-b')).toEqual([targets[3]])
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

  it('retains the subscription owner when an older runtime omits event connection identity', async () => {
    const target = runtimeTarget()
    subscriptionState.subscribeRuntimeFileChanges.mockResolvedValueOnce(vi.fn())
    subscriptionState.snapshot = { targets: [target], targetsKey: 'legacy-runtime-watch' }
    await act(async () => root.render(createElement(WatchProbe)))
    const callback = subscriptionState.subscribeRuntimeFileChanges.mock.calls[0][1]
    const payload = {
      worktreePath: target.worktreePath,
      events: [{ kind: 'update', absolutePath: `${target.worktreePath}/notes.md` }]
    }
    callback(payload)
    expect(subscriptionState.handleFsChanged).toHaveBeenCalledExactlyOnceWith(
      { ...payload, connectionId: target.connectionId },
      target.runtimeEnvironmentId,
      target.worktreeId
    )
  })

  it('routes same-root runtime streams only to their captured workspace selectors', async () => {
    const targets = ['runtime-a', 'runtime-b'].map((worktreeId) => ({
      ...runtimeTarget(),
      worktreeId
    }))
    subscriptionState.subscribeRuntimeFileChanges
      .mockResolvedValueOnce(vi.fn())
      .mockResolvedValueOnce(vi.fn())
    subscriptionState.snapshot = { targets, targetsKey: 'two-runtime-workspaces' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(subscriptionState.subscribeRuntimeFileChanges).toHaveBeenCalledTimes(2)
    const lookup = vi.mocked(buildEditorExternalWatchEventHandler).mock.calls[0][0]
    const payload = { worktreePath: targets[0].worktreePath, events: [] }
    for (const [index, target] of targets.entries()) {
      const callback = subscriptionState.subscribeRuntimeFileChanges.mock.calls[index][1]
      callback(payload)
      expect(subscriptionState.handleFsChanged).toHaveBeenLastCalledWith(
        { ...payload, connectionId: target.connectionId },
        target.runtimeEnvironmentId,
        target.worktreeId
      )
      expect(
        lookup(
          target.worktreePath,
          target.runtimeEnvironmentId,
          target.connectionId,
          target.worktreeId
        )
      ).toEqual([target])
    }
  })

  it('shares the physical watch while retaining each owner alias policy', async () => {
    const first: TestWatchTarget = {
      worktreeId: 'first',
      worktreePath: 'C:/Repo',
      connectionId: undefined,
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    }
    const second: TestWatchTarget = {
      ...first,
      worktreeId: 'second',
      allowLocalWindowsWslAliases: undefined
    }
    subscriptionState.snapshot = { targets: [first, second], targetsKey: 'mixed-alias-policy' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(watchWorktree).toHaveBeenCalledExactlyOnceWith({
      worktreePath: 'C:/Repo',
      connectionId: undefined
    })
    const lookup = vi.mocked(buildEditorExternalWatchEventHandler).mock.calls[0][0]
    expect(lookup('c:/repo', null)).toEqual([first, second])
  })

  it('does not let a pending local watch resolution tear down a re-added owner', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((settle) => {
      resolve = settle
    })
    watchWorktree.mockReturnValueOnce(pending)
    const target: TestWatchTarget = {
      worktreeId: 'first',
      worktreePath: '/shared',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const second = { ...target, worktreeId: 'second' }
    subscriptionState.snapshot = { targets: [target, second], targetsKey: 'pending-both' }
    await act(async () => root.render(createElement(WatchProbe)))
    subscriptionState.snapshot = { targets: [second], targetsKey: 'pending-one' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(unwatchWorktree).not.toHaveBeenCalled()
    subscriptionState.snapshot = { targets: [], targetsKey: 'pending-none' }
    await act(async () => root.render(createElement(WatchProbe)))
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    subscriptionState.snapshot = { targets: [second], targetsKey: 'pending-readded' }
    await act(async () => root.render(createElement(WatchProbe)))
    resolve()
    await act(async () => pending)
    expect(watchWorktree).toHaveBeenCalledTimes(2)
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(unwatchWorktree).toHaveBeenCalledTimes(2)
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
