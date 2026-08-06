import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { captureDirectSshMutationExpectation } from './ssh-mutation-expectation'

function stateWithGenerations(): Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'> {
  return {
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
