import { describe, expect, it, vi } from 'vitest'
import { subscribeRuntimeFileChanges } from './runtime-file-client'
import {
  fsOnChanged,
  runtimeEnvironmentCall,
  runtimeEnvironmentSubscribe,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('uses the local fs changed stream when no runtime environment is active', async () => {
    const unsubscribe = vi.fn()
    const onPayload = vi.fn()
    fsOnChanged.mockReturnValue(unsubscribe)

    await expect(
      subscribeRuntimeFileChanges(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        onPayload
      )
    ).resolves.toBe(unsubscribe)

    expect(fsOnChanged).toHaveBeenCalledWith(onPayload)
    expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
  })

  it('maps runtime file watch events back to fs changed payloads', async () => {
    const onPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const stop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      onPayload
    )

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'files.watch',
        params: { worktree: 'id:wt-1' },
        timeoutMs: 15_000
      },
      expect.any(Object)
    )

    onResponse?.({
      id: 'rpc-1',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(onPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })

    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('surfaces terminal watcher errors and allows a fresh subscription after stream end', async () => {
    const onError = vi.fn()
    const unsubscribe = vi.fn()
    let callbacks: { onResponse: (response: unknown) => void; onClose: () => void } | undefined
    runtimeEnvironmentSubscribe.mockImplementation((_args, nextCallbacks) => {
      callbacks = nextCallbacks
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      vi.fn(),
      onError
    )
    callbacks?.onResponse({
      id: 'rpc-error',
      ok: true,
      result: { type: 'error', message: 'file watcher process crashed repeatedly' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    callbacks?.onResponse({
      id: 'rpc-end',
      ok: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'file watcher process crashed repeatedly' })
    )
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      vi.fn(),
      vi.fn()
    )
    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(2)
    callbacks?.onResponse({
      id: 'rpc-second-end',
      ok: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('evicts a terminal watch before notifying error listeners that retry', async () => {
    const callbacks: {
      onResponse: (response: unknown) => void
      onClose: () => void
    }[] = []
    runtimeEnvironmentSubscribe.mockImplementation((_args, nextCallbacks) => {
      callbacks.push(nextCallbacks)
      return Promise.resolve({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
    })
    const retryPayload = vi.fn()
    let retryPromise: Promise<() => void> | undefined
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }
    await subscribeRuntimeFileChanges(context, vi.fn(), () => {
      retryPromise = subscribeRuntimeFileChanges(context, retryPayload, vi.fn())
    })

    callbacks[0].onResponse({
      id: 'rpc-error',
      ok: true,
      result: { type: 'error', message: 'terminal watcher failure' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await retryPromise
    const subscribeCallCount = runtimeEnvironmentSubscribe.mock.calls.length
    callbacks[0].onResponse({
      id: 'rpc-end',
      ok: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    callbacks[1]?.onResponse({
      id: 'rpc-changed',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/retry.txt' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    callbacks[1]?.onResponse({
      id: 'rpc-retry-end',
      ok: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(subscribeCallCount).toBe(2)
    expect(retryPayload).toHaveBeenCalledTimes(1)
  })

  it('evicts a failed watcher setup before notifying retrying listeners', async () => {
    const callbacks: { onResponse: (response: unknown) => void; onClose: () => void }[] = []
    const unsubscribes = [vi.fn(), vi.fn()]
    runtimeEnvironmentSubscribe.mockImplementation((_args, nextCallbacks) => {
      callbacks.push(nextCallbacks)
      return Promise.resolve({
        unsubscribe: unsubscribes[callbacks.length - 1],
        sendBinary: vi.fn()
      })
    })
    const retryPayload = vi.fn()
    let retryPromise: Promise<() => void> | undefined
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }
    await subscribeRuntimeFileChanges(context, vi.fn(), () => {
      retryPromise = subscribeRuntimeFileChanges(context, retryPayload, vi.fn())
    })

    callbacks[0].onResponse({
      id: 'rpc-setup-failed',
      ok: false,
      error: { code: 'watch_failed', message: 'root unavailable' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await retryPromise

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
    callbacks[1]?.onResponse({
      id: 'rpc-changed',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/retry.txt' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    expect(retryPayload).toHaveBeenCalledTimes(1)
    callbacks[1]?.onResponse({
      id: 'rpc-retry-end',
      ok: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('shares one remote file watch subscription across listeners for the same worktree', async () => {
    const firstPayload = vi.fn()
    const secondPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'unwatch',
      ok: true,
      result: { unsubscribed: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const firstStop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      firstPayload
    )
    const secondStop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      secondPayload
    )

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(1)
    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-1' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    onResponse?.({
      id: 'changed',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(firstPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })
    expect(secondPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })

    firstStop()
    expect(unsubscribe).not.toHaveBeenCalled()

    secondStop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.unwatch',
        params: { subscriptionId: 'files-watch-1' },
        timeoutMs: 5_000
      })
    )
  })

  it('delegates stopped pre-ready web shared file watch cleanup to the subscription handle', async () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    const onPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const stop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      onPayload
    )

    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.unwatch' })
    )

    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-late' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.unwatch' })
    )
  })

  it('delegates stopped ready web shared file watch cleanup to the subscription handle', async () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    const onPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const stop = await subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      onPayload
    )

    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-ready' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    stop()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.unwatch' })
    )
  })
})
