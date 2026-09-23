import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { captureDirectSshMutationExpectation } from './ssh-mutation-expectation'

function stateWithGenerations(): Pick<
  AppState,
  'sshConnectionStates' | 'sshStateByEnvironment' | 'runtimeOwnedSshConnectionStates'
> {
  return {
    runtimeOwnedSshConnectionStates: new Map(),
    sshConnectionStates: new Map([
      [
        'ssh-1',
        {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 3
        }
      ]
    ]),
    sshStateByEnvironment: new Map([
      [
        'hub-1',
        {
          connectionStates: new Map([
            [
              'ssh-1',
              {
                targetId: 'ssh-1',
                status: 'connected',
                error: null,
                reconnectAttempt: 0,
                connectionGeneration: 9
              }
            ]
          ]),
          targets: [],
          targetGenerations: new Map(),
          targetLabels: new Map(),
          removedTargetLabels: new Map(),
          targetsHydrated: true
        }
      ]
    ])
  }
}

describe('captureDirectSshMutationExpectation', () => {
  it('scopes the generation lookup to the runtime that owns the SSH target', () => {
    expect(captureDirectSshMutationExpectation(stateWithGenerations(), 'ssh-1', 'hub-1')).toEqual({
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 9
    })
  })

  it('uses client-local SSH state only for client-owned connections', () => {
    expect(captureDirectSshMutationExpectation(stateWithGenerations(), 'ssh-1')).toEqual({
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 3
    })
  })

  it('fails closed when the owning runtime has not published a generation', () => {
    expect(() =>
      captureDirectSshMutationExpectation(stateWithGenerations(), 'ssh-1', 'hub-2')
    ).toThrow("Couldn't verify the SSH connection")
  })
})

it('uses recipe authority without registering the VM as a user-managed host', () => {
  const targetId = 'runtime-ssh-orca-vm'
  const state = {
    ...stateWithGenerations(),
    runtimeOwnedSshConnectionStates: new Map([
      [
        targetId,
        {
          targetId,
          status: 'connected' as const,
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 42
        }
      ]
    ])
  }
  expect(captureDirectSshMutationExpectation(state, targetId).expectedSshConnectionGeneration).toBe(
    42
  )
  expect(() => captureDirectSshMutationExpectation(state, targetId, 'hub-1')).toThrow()
  state.runtimeOwnedSshConnectionStates.clear()
  expect(() => captureDirectSshMutationExpectation(state, targetId)).toThrow()
})

it('does not authorize recipe mutations with disconnected or stale ordinary-host state', () => {
  const targetId = 'runtime-ssh-orca-vm'
  const stale = {
    targetId,
    status: 'disconnected' as const,
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: 42
  }
  const state = {
    ...stateWithGenerations(),
    runtimeOwnedSshConnectionStates: new Map([[targetId, stale]])
  }
  state.sshConnectionStates.set(targetId, { ...stale, status: 'connected' })
  expect(() => captureDirectSshMutationExpectation(state, targetId)).toThrow()
})
