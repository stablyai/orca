import { vi } from 'vitest'
import { buildStoreState } from './ipc-events-agent-status-store-test-fixtures'
import type { StoreLike } from './ipc-events-agent-status-store-test-fixtures'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'

/** Store doubles for the partial-authority reconciliation path; the spec wires them. */
export function buildSshAuthorityReconciliationHarness(args: {
  partialAuthority: { providerEpoch?: string; connectionGeneration?: number }
  latestAuthority: { providerEpoch: string; connectionGeneration: number }
}): {
  emitPartialState: () => void
  getState: ReturnType<typeof vi.fn>
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
  const setSshConnectionState = vi.fn((nextTargetId: string, state: Record<string, unknown>) => {
    sshConnectionStates.set(nextTargetId, state)
  })
  const storeState = buildStoreState({
    sshTargetLabels: new Map([[targetId, 'Reconciliation Target']]),
    sshConnectionStates,
    setSshConnectionState,
    setSshTargetsMetadata: vi.fn(),
    setRemovedSshTargetLabels: vi.fn(),
    clearRemoteDetectedAgents: vi.fn(),
    clearRemovedSshTargetState: vi.fn()
  })
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
    emitPartialState: () => {
      if (!sshStateListener) {
        throw new Error('Expected SSH state listener')
      }
      sshStateListener({ targetId, state: partialState })
    },
    getState,
    setSshConnectionState,
    storeState,
    storedState: () => sshConnectionStates.get(targetId)
  }
}
