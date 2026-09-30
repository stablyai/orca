import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  DirectSshAuthority,
  SshConnectionState,
  SshProviderEpoch
} from '../../../../shared/ssh-types'
import { createDirectSshBridgeRuntime } from './direct-ssh-bridge-runtime'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'

function connectedState(
  targetId = 'target-a',
  generation = 1
): SshConnectionState & DirectSshAuthority {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests issue a fixed opaque provider token for each target.
    providerEpoch: `epoch-${targetId}` as SshProviderEpoch,
    connectionGeneration: generation
  }
}

function authority(state: DirectSshAuthority): DirectSshAuthority {
  return {
    targetId: state.targetId,
    providerEpoch: state.providerEpoch,
    connectionGeneration: state.connectionGeneration
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await Promise.resolve()
  }
}

const originalStore = useAppStore.getState()
const cleanups: (() => void)[] = []

async function createHarness(
  initialStates: readonly SshConnectionState[] = [],
  reconciledStates: readonly SshConnectionState[] = []
) {
  const states = new Map(initialStates.map((state) => [state.targetId, state]))
  const reconciled = new Map(reconciledStates.map((state) => [state.targetId, state]))
  let stateListener: ((event: { targetId: string; state: unknown }) => void) | undefined
  const getState = vi.fn(async ({ targetId }: { targetId: string }) => {
    const state = states.get(targetId) ?? null
    const next = reconciled.get(targetId)
    if (next) {
      states.set(targetId, next)
    }
    return state
  })
  const targets = ['target-a', 'target-b'].map((id) => ({ id, label: id }))
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    api: {
      ui: {},
      repos: {},
      worktrees: {},
      ssh: {
        listTargets: async () => targets,
        listRemovedTargetLabels: async () => ({}),
        getState,
        listPortForwards: async () => [],
        listDetectedPorts: async () => [],
        onCredentialRequest: () => () => {},
        onCredentialResolved: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onStateChanged: (listener: typeof stateListener) => {
          stateListener = listener
          return () => {}
        }
      }
    }
  })
  const store = useAppStore.getState()
  const invalidate = vi.spyOn(store, 'invalidateStaleDirectSshTargetPtyBindings').mockReturnValue(1)
  const retry = vi.spyOn(store, 'retryDirectSshTargetPanes').mockReturnValue(1)
  const clearBindings = vi.spyOn(store, 'clearDirectSshTargetPtyBindings').mockReturnValue(1)
  const runtime = createDirectSshBridgeRuntime()
  const requestReconnect = vi.spyOn(runtime.reconnectCoordinator, 'requestReconnect')
  const prepareAndSync = vi.spyOn(runtime, 'prepareAndSync')
  const unsubs: (() => void)[] = []
  cleanups.push(() => {
    for (const unsubscribe of unsubs) {
      unsubscribe()
    }
    runtime.stop()
  })
  registerDirectSshStateIpcBridge(unsubs, runtime)
  await settle()
  return {
    runtime,
    getState,
    invalidate,
    retry,
    clearBindings,
    requestReconnect,
    prepareAndSync,
    emit: (state: SshConnectionState) => {
      if (!stateListener) {
        throw new Error('SSH state listener was not registered')
      }
      stateListener({ targetId: state.targetId, state })
    },
    applyConnectReply: (state: SshConnectionState) => {
      useAppStore.getState().setSshConnectionState(state.targetId, state)
    }
  }
}

beforeEach(() => {
  useAppStore.setState(originalStore, true)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  await settle()
  vi.restoreAllMocks()
  useAppStore.setState(originalStore, true)
  vi.unstubAllGlobals()
})

describe('direct SSH connect reply routing', () => {
  it.each(['reply-first', 'push-first'] as const)(
    'retries through the real coordinator once when connection ordering is %s',
    async (ordering) => {
      const harness = await createHarness()
      const state = connectedState()
      if (ordering === 'reply-first') {
        harness.applyConnectReply(state)
      }
      harness.emit(state)
      if (ordering === 'push-first') {
        harness.applyConnectReply(state)
      }

      expect(harness.requestReconnect).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.invalidate).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.runtime.reconnectAuthorityByTarget.get(state.targetId)).toEqual(
        authority(state)
      )
      await settle()

      harness.retry.mockClear()
      harness.emit({ ...state })

      expect(harness.requestReconnect).toHaveBeenCalledOnce()
      expect(harness.invalidate).toHaveBeenCalledOnce()
      expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.prepareAndSync).toHaveBeenLastCalledWith(authority(state), 'wake-refresh')
    }
  )

  it('keeps hydration preparation-only and corrects its duplicate without requesting reconnect', async () => {
    const state = connectedState()
    const harness = await createHarness([state])

    expect(harness.prepareAndSync).toHaveBeenCalledExactlyOnceWith(
      authority(state),
      'initial-hydration'
    )
    expect(harness.requestReconnect).not.toHaveBeenCalled()
    expect(harness.invalidate).not.toHaveBeenCalled()
    expect(harness.retry).not.toHaveBeenCalled()

    harness.emit({ ...state })

    expect(harness.requestReconnect).not.toHaveBeenCalled()
    expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(state))
    expect(harness.runtime.reconnectAuthorityByTarget.size).toBe(0)

    const next = connectedState(state.targetId, 2)
    harness.applyConnectReply(next)
    harness.retry.mockClear()
    harness.emit(next)

    expect(harness.requestReconnect).toHaveBeenCalledExactlyOnceWith(authority(next))
    expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(next))
  })

  it.each(['disconnected', 'error'] as const)(
    'forgets a routed authority after %s even when the next connect reply reaches the store first',
    async (status) => {
      const state = connectedState()
      const harness = await createHarness([state])
      harness.emit({ ...state, status })

      expect(harness.clearBindings).toHaveBeenCalledExactlyOnceWith(state.targetId)
      harness.applyConnectReply(state)
      harness.emit(state)

      expect(harness.requestReconnect).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.runtime.reconnectAuthorityByTarget.get(state.targetId)).toEqual(
        authority(state)
      )
    }
  )

  it.each(['providerEpoch', 'connectionGeneration'] as const)(
    'preserves initial hydration routing when %s must be reconciled',
    async (missingField) => {
      const state = connectedState()
      const partial: SshConnectionState = { ...state }
      delete partial[missingField]
      const harness = await createHarness([partial], [state])

      expect(useAppStore.getState().sshConnectionStates.get(state.targetId)).toEqual(state)
      expect(harness.prepareAndSync).toHaveBeenCalledExactlyOnceWith(
        authority(state),
        'initial-hydration'
      )
      expect(harness.requestReconnect).not.toHaveBeenCalled()
      expect(harness.retry).not.toHaveBeenCalled()

      harness.emit(state)

      expect(harness.requestReconnect).not.toHaveBeenCalled()
      expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.runtime.reconnectAuthorityByTarget.size).toBe(0)
    }
  )

  it.each(['providerEpoch', 'connectionGeneration'] as const)(
    'waits for partial authority reconciliation when %s is missing',
    async (missingField) => {
      const harness = await createHarness()
      const state = connectedState()
      let resolveState!: (state: SshConnectionState) => void
      harness.getState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveState = resolve
          })
      )
      harness.applyConnectReply(state)
      const partial: SshConnectionState = { ...state }
      delete partial[missingField]
      harness.emit(partial)

      expect(harness.requestReconnect).not.toHaveBeenCalled()
      expect(harness.retry).not.toHaveBeenCalled()
      resolveState(state)
      await settle()

      expect(harness.requestReconnect).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.invalidate).toHaveBeenCalledExactlyOnceWith(authority(state))
      expect(harness.retry).toHaveBeenCalledWith(authority(state))
      harness.emit(state)
      expect(harness.requestReconnect).toHaveBeenCalledOnce()
    }
  )

  it('keeps routed authorities and disconnect cleanup separate for each target', async () => {
    const harness = await createHarness()
    const first = connectedState('target-a')
    const second = connectedState('target-b')
    for (const state of [first, second]) {
      harness.applyConnectReply(state)
      harness.emit(state)
    }
    await settle()
    expect(harness.requestReconnect.mock.calls).toEqual([[authority(first)], [authority(second)]])

    harness.emit({ ...first, status: 'disconnected' })
    harness.retry.mockClear()
    harness.emit(second)

    expect(harness.requestReconnect).toHaveBeenCalledTimes(2)
    expect(harness.retry).toHaveBeenCalledExactlyOnceWith(authority(second))
    expect(harness.runtime.reconnectAuthorityByTarget.get(second.targetId)).toEqual(
      authority(second)
    )
    expect(harness.runtime.reconnectAuthorityByTarget.has(first.targetId)).toBe(false)

    harness.applyConnectReply(first)
    harness.emit(first)
    expect(harness.requestReconnect).toHaveBeenNthCalledWith(3, authority(first))
  })
})
