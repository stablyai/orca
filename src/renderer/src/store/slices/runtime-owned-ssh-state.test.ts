import { expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { getLocalSshTargetConnectionGeneration } from './ssh'

it('refreshes connected consumers only on connection transitions while fencing changed authority', () => {
  const store = createTestStore()
  const targetId = 'runtime-ssh-refresh-vm'
  const connected = {
    targetId,
    status: 'connected' as const,
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: 42
  }
  const initialRefresh = store.getState().sshConnectedGeneration
  store.getState().setRuntimeOwnedSshConnectionState(targetId, connected)
  expect(store.getState().sshConnectedGeneration).toBe(initialRefresh + 1)

  const afterConnect = store.getState()
  store.getState().setRuntimeOwnedSshConnectionState(targetId, { ...connected })
  expect(store.getState()).toBe(afterConnect)

  const operationGeneration = getLocalSshTargetConnectionGeneration(targetId)
  store.getState().setRuntimeOwnedSshConnectionState(targetId, {
    ...connected,
    remotePlatform: 'linux',
    connectionGeneration: 43
  })
  expect(store.getState().sshConnectedGeneration).toBe(initialRefresh + 1)
  expect(getLocalSshTargetConnectionGeneration(targetId)).toBe(operationGeneration + 1)

  store
    .getState()
    .setRuntimeOwnedSshConnectionState(targetId, { ...connected, status: 'disconnected' })
  expect(store.getState().sshConnectedGeneration).toBe(initialRefresh + 1)
  store
    .getState()
    .setRuntimeOwnedSshConnectionState(targetId, { ...connected, connectionGeneration: 44 })
  expect(store.getState().sshConnectedGeneration).toBe(initialRefresh + 2)
  store.getState().setRuntimeOwnedSshConnectionState(targetId, null)
  expect(store.getState().runtimeOwnedSshConnectionStates.has(targetId)).toBe(false)
  expect(store.getState().sshConnectedGeneration).toBe(initialRefresh + 2)
})
