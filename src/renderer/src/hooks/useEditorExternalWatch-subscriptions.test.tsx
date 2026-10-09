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
  disposeEventHandler: vi.fn(),
  handleFsChanged: vi.fn(),
  contacts: new Map<string, () => void>(),
  unsubscribeContact: vi.fn(),
  captureBaseline: vi.fn(async () => new Map<string, string>()),
  collectCatchUpEvents: vi.fn(async (): Promise<unknown[]> => []),
  releaseAutosave: vi.fn(),
  holdAutosave: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (id: string, listener: () => void) => {
    subscriptionState.contacts.set(id, listener)
    return subscriptionState.unsubscribeContact
  }
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
vi.mock('./editor-external-watch-catch-up', () => ({
  captureEditorWatchDiskBaseline: subscriptionState.captureBaseline,
  collectEditorWatchCatchUpEvents: subscriptionState.collectCatchUpEvents,
  holdEditorAutosaveDuringCatchUp: subscriptionState.holdAutosave
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.clearAllMocks()
    subscriptionState.holdAutosave.mockReturnValue(subscriptionState.releaseAutosave)
    subscriptionState.contacts.clear()
    subscriptionState.subscribeRuntimeFileChanges.mockReset()
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
    vi.useRealTimers()
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
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
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

  it('retries a failed initial watch when the same host answers again', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscriptionState.subscribeRuntimeFileChanges
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(vi.fn())
    subscriptionState.snapshot = { targets: [runtimeTarget()], targetsKey: 'recovering-watch' }
    try {
      await act(async () => root.render(createElement(WatchProbe)))
      await act(async () => subscriptionState.contacts.get('runtime-1')?.())
      expect(subscriptionState.subscribeRuntimeFileChanges).toHaveBeenCalledTimes(2)
      expect(subscriptionState.handleFsChanged).toHaveBeenCalledWith(
        {
          worktreePath: '/runtime/repo',
          events: [{ kind: 'overflow', absolutePath: '/runtime/repo' }]
        },
        'runtime-1'
      )
    } finally {
      warning.mockRestore()
    }
  })

  it('replaces a lost watch and stops contact recovery when the editor unmounts', async () => {
    const firstStop = vi.fn()
    const secondStop = vi.fn()
    subscriptionState.subscribeRuntimeFileChanges
      .mockResolvedValueOnce(firstStop)
      .mockResolvedValueOnce(secondStop)
    subscriptionState.snapshot = { targets: [runtimeTarget()], targetsKey: 'live-watch' }
    await act(async () => root.render(createElement(WatchProbe)))
    await act(async () => subscriptionState.contacts.get('runtime-1')?.())
    expect(firstStop).toHaveBeenCalledOnce()
    expect(subscriptionState.subscribeRuntimeFileChanges).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
    expect(secondStop).toHaveBeenCalledOnce()
    expect(subscriptionState.unsubscribeContact).toHaveBeenCalledOnce()
    subscriptionState.contacts.get('runtime-1')?.()
    expect(subscriptionState.subscribeRuntimeFileChanges).toHaveBeenCalledTimes(2)
  })

  describe('dropping and regaining a watch', () => {
    const localTarget: TestWatchTarget = {
      worktreeId: 'wt-local',
      worktreePath: '/repo/local',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const watchLocal = async (targetsKey: string): Promise<void> => {
      subscriptionState.snapshot = { targets: [localTarget], targetsKey }
      await act(async () => root.render(createElement(WatchProbe)))
    }
    const dropLocal = async (): Promise<void> => {
      subscriptionState.snapshot = { targets: [], targetsKey: 'none' }
      await act(async () => root.render(createElement(WatchProbe)))
    }

    it('stamps open files and stays subscribed until the baseline settles', async () => {
      await watchLocal('local-1')
      await dropLocal()

      expect(subscriptionState.captureBaseline).toHaveBeenCalledWith(localTarget)
      expect(unwatchWorktree).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      expect(unwatchWorktree).toHaveBeenCalledOnce()
    })

    it('keeps the watch without a catch-up when the worktree returns mid-drain', async () => {
      await watchLocal('local-1')
      await dropLocal()
      await watchLocal('local-2')
      await act(async () => vi.advanceTimersByTimeAsync(2_000))

      expect(unwatchWorktree).not.toHaveBeenCalled()
      expect(watchWorktree).toHaveBeenCalledOnce()
      expect(subscriptionState.collectCatchUpEvents).not.toHaveBeenCalled()
    })

    it('replays missed changes through the live event path once the watch is regained', async () => {
      const baseline = new Map([['/repo/local/a.ts', '1:1']])
      const missed = [{ kind: 'update', absolutePath: '/repo/local/a.ts' }]
      subscriptionState.captureBaseline.mockResolvedValueOnce(baseline)
      subscriptionState.collectCatchUpEvents.mockResolvedValueOnce(missed)
      await watchLocal('local-1')
      await dropLocal()
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      await watchLocal('local-2')

      expect(watchWorktree).toHaveBeenCalledTimes(2)
      expect(subscriptionState.collectCatchUpEvents).toHaveBeenCalledWith(localTarget, baseline)
      expect(subscriptionState.handleFsChanged).toHaveBeenCalledWith(
        { worktreePath: '/repo/local', events: missed },
        null
      )
      expect(subscriptionState.holdAutosave).toHaveBeenCalledWith(localTarget, baseline)
      expect(subscriptionState.releaseAutosave).toHaveBeenCalledOnce()
      expect(subscriptionState.releaseAutosave.mock.invocationCallOrder[0]).toBeGreaterThan(
        subscriptionState.handleFsChanged.mock.invocationCallOrder[0]
      )
    })
  })
})
