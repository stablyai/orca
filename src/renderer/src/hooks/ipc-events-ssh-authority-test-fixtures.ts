import { vi } from 'vitest'
import { buildStoreState } from './ipc-events-agent-status-store-test-fixtures'
import type { StoreLike } from './ipc-events-agent-status-store-test-fixtures'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'

export type DirectSshReconnectCoordinatorDouble = {
  requestReconnect: ReturnType<typeof vi.fn>
  replaceAuthority: ReturnType<typeof vi.fn>
  prepareOnly: ReturnType<typeof vi.fn>
  correctUnboundTerminals: ReturnType<typeof vi.fn>
  finalizeHydratedTerminals: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

/** Store/coordinator doubles for the partial-authority reconciliation path; the spec wires them. */
export function buildSshAuthorityReconciliationHarness(args: {
  partialAuthority: { providerEpoch?: string; connectionGeneration?: number }
  latestAuthority: { providerEpoch: string; connectionGeneration: number }
}): {
  coordinator: DirectSshReconnectCoordinatorDouble
  emitPartialState: () => void
  getState: ReturnType<typeof vi.fn>
  requestReconnect: ReturnType<typeof vi.fn>
  setSshConnectionState: ReturnType<typeof vi.fn>
  storeState: StoreLike
  storedState: () => Record<string, unknown> | undefined
} {
  const targetId = 'target-reconciliation'
  const baseState = {
    targetId,
    status: 'connected' as const,
    error: null,
    reconnectAttempt: 0
  }
  const partialState = { ...baseState, ...args.partialAuthority }
  const latestState = { ...baseState, ...args.latestAuthority }
  const sshConnectionStates = new Map<string, Record<string, unknown>>()
  let sshStateListener: ((data: { targetId: string; state: unknown }) => void) | undefined
  const getState = vi.fn(() => Promise.resolve(latestState))
  const requestReconnect = vi.fn(async () => ({ status: 'complete' }))
  const setSshConnectionState = vi.fn((nextTargetId: string, state: Record<string, unknown>) => {
    sshConnectionStates.set(nextTargetId, state)
  })
  const storeState = buildStoreState({
    sshTargetLabels: new Map([[targetId, 'Reconciliation Target']]),
    sshConnectionStates,
    setSshConnectionState,
    invalidateStaleDirectSshTargetPtyBindings: vi.fn(() => 0),
    retryDirectSshTargetPanes: vi.fn(() => 0),
    setSshTargetsMetadata: vi.fn(),
    setRemovedSshTargetLabels: vi.fn(),
    setRemoteWorkspaceSyncStatus: vi.fn(),
    clearRemoteDetectedAgents: vi.fn(),
    clearDirectSshTargetPtyBindings: vi.fn(),
    clearRemovedSshTargetState: vi.fn()
  })
  const coordinator = {
    requestReconnect,
    replaceAuthority: vi.fn(),
    prepareOnly: vi.fn(),
    correctUnboundTerminals: vi.fn(() => 0),
    finalizeHydratedTerminals: vi.fn(() => 0),
    invalidate: vi.fn(),
    stop: vi.fn()
  }

  vi.stubGlobal(
    'window',
    buildWindowApi({
      onSet: () => () => {},
      ssh: {
        getState,
        onStateChanged: (listener: (data: { targetId: string; state: unknown }) => void) => {
          sshStateListener = listener
          return () => {}
        }
      }
    })
  )

  return {
    coordinator,
    emitPartialState: () => {
      if (!sshStateListener) {
        throw new Error('Expected SSH state listener')
      }
      sshStateListener({ targetId, state: partialState })
    },
    getState,
    requestReconnect,
    setSshConnectionState,
    storeState,
    storedState: () => sshConnectionStates.get(targetId)
  }
}
