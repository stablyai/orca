import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { createCompatibleRuntimeStatusResponse } from '../../rpc/testing/runtime-compatibility-test-fixture'
import { terminalSetupStreamLifecycle, waitForRuntimeTerminalSetup } from './runtime-terminal-setup'
import type { TerminalSetupStatus } from '../../../../../shared/terminal/pty/lifecycle/terminal-setup-status'

const pending: TerminalSetupStatus = {
  runtimeId: 'runtime-a',
  ptyId: 'pty-a',
  dependencyId: 'attempt-a',
  state: 'pending'
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Setup status RPC outage recovery', () => {
  it.each([
    { failedRead: 1, invoke: false },
    { failedRead: 2, invoke: false },
    { failedRead: 1, invoke: true },
    { failedRead: 2, invoke: true }
  ])('retains the draft after a read socket fails: %j', async ({ failedRead, invoke }) => {
    vi.useFakeTimers()
    const scope = `rpc-socket-${failedRead}-${invoke}`
    type Callbacks = Parameters<Window['api']['runtimeEnvironments']['subscribe']>[1]
    const readers: Callbacks[] = []
    const handshake = Promise.withResolvers<{ unsubscribe: () => void; sendBinary: () => void }>()
    const subscribe = vi.fn(async (_args, callbacks: Callbacks) => {
      readers.push(callbacks)
      if (readers.length < failedRead) {
        callbacks.onResponse({
          id: 'read',
          _meta: { runtimeId: 'runtime-a' },
          ok: true,
          result: pending
        })
      }
      if (invoke && readers.length === failedRead) {
        return handshake.promise
      }
      return { unsubscribe: () => {}, sendBinary: () => {} }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: async () => createCompatibleRuntimeStatusResponse(),
          subscribe,
          cancelSubscription: async () => {}
        }
      }
    })
    const stream = terminalSetupStreamLifecycle(
      scope,
      () => true,
      () => {},
      () => {}
    )
    stream.callbacks.onReady()
    const abort = new AbortController()
    const wait = waitForRuntimeTerminalSetup(toRemoteRuntimePtyId('terminal', scope), abort.signal)
    const result = wait.then(
      () => 'delivered',
      () => 'refused'
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(readers).toHaveLength(failedRead)
      if (invoke) {
        handshake.reject(
          new Error(
            "Error invoking remote method 'runtimeEnvironments:subscribe': Error: Could not connect to the remote Orca runtime."
          )
        )
      } else {
        readers[failedRead - 1].onError?.({
          code: 'remote_runtime_unavailable',
          message: 'Could not connect to the remote Orca runtime.'
        })
      }
      await vi.advanceTimersByTimeAsync(0)
      stream.callbacks.onReady()
      await vi.advanceTimersByTimeAsync(0)
      readers
        .at(-1)
        ?.onResponse({
          id: 'read',
          _meta: { runtimeId: 'runtime-a' },
          ok: true,
          result: { ...pending, state: 'ready' }
        })
      await expect(result).resolves.toBe('delivered')
    } finally {
      abort.abort()
      stream.callbacks.onClose()
      await result
    }
  })
})

it.each(['runtime_unavailable', 'runtime_timeout', 'runtime_busy', 'invoke-admission'])(
  'refuses only the affected draft after a healthy-host refusal: %s',
  async (code) => {
    vi.useFakeTimers()
    const scope = `rpc-live-${code}`
    let fail = true
    type Callbacks = Parameters<Window['api']['runtimeEnvironments']['subscribe']>[1]
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: async () => createCompatibleRuntimeStatusResponse(),
          cancelSubscription: async () => {},
          subscribe: async (_args: unknown, callbacks: Callbacks) => {
            if (fail && code === 'invoke-admission') {
              throw new Error('Remote runtime subscription limit reached')
            }
            callbacks.onResponse(
              fail
                ? {
                    id: 'read',
                    ok: false,
                    error: { code, message: 'Could not connect to the remote Orca runtime.' }
                  }
                : {
                    id: 'read',
                    _meta: { runtimeId: 'runtime-a' },
                    ok: true,
                    result: { ...pending, state: 'ready' }
                  }
            )
            return { unsubscribe: () => {} }
          }
        }
      }
    })
    const stream = terminalSetupStreamLifecycle(
      scope,
      () => true,
      () => {},
      () => {}
    )
    stream.callbacks.onReady()
    const abort = new AbortController()
    try {
      await expect(
        waitForRuntimeTerminalSetup(toRemoteRuntimePtyId('terminal', scope), abort.signal)
      ).rejects.toBeInstanceOf(Error)
      fail = false
      await expect(
        waitForRuntimeTerminalSetup(toRemoteRuntimePtyId('successor', scope), abort.signal)
      ).resolves.toBeUndefined()
    } finally {
      abort.abort()
      stream.callbacks.onClose()
    }
  }
)

it('ignores a late failed subscription from the read aborted by reconnect', async () => {
  vi.useFakeTimers()
  const scope = 'rpc-late-predecessor'
  type Callbacks = Parameters<Window['api']['runtimeEnvironments']['subscribe']>[1]
  const readers: Callbacks[] = []
  const old = Promise.withResolvers<{ unsubscribe: () => void }>()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: async () => createCompatibleRuntimeStatusResponse(),
        cancelSubscription: async () => {},
        subscribe: async (_args: unknown, callbacks: Callbacks) => {
          readers.push(callbacks)
          return readers.length === 1 ? old.promise : { unsubscribe: () => {} }
        }
      }
    }
  })
  const stream = terminalSetupStreamLifecycle(
    scope,
    () => true,
    () => {},
    () => {}
  )
  stream.callbacks.onReady()
  const abort = new AbortController()
  const wait = waitForRuntimeTerminalSetup(toRemoteRuntimePtyId('terminal', scope), abort.signal)
  const result = wait.then(
    () => 'delivered',
    () => 'refused'
  )
  try {
    await vi.advanceTimersByTimeAsync(0)
    stream.callbacks.onError({
      code: 'remote_runtime_unavailable',
      message: 'Remote Orca runtime closed the connection.'
    })
    stream.callbacks.onReady()
    await vi.advanceTimersByTimeAsync(0)
    old.reject(new Error('Could not connect to the remote Orca runtime.'))
    readers[0].onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Could not connect to the remote Orca runtime.'
    })
    readers[0].onClose?.()
    await vi.advanceTimersByTimeAsync(0)
    readers
      .at(-1)
      ?.onResponse({
        id: 'read',
        _meta: { runtimeId: 'runtime-a' },
        ok: true,
        result: { ...pending, state: 'ready' }
      })
    await expect(result).resolves.toBe('delivered')
  } finally {
    abort.abort()
    stream.callbacks.onClose()
    await result
  }
})
