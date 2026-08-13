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

  // #11762: runtime-owned (ephemeral-VM) targets are suppressed from ssh:state-changed, so their
  // authority lives in its own map. Callers reach here with the runtime id omitted, undefined or null.
  describe('runtime-owned SSH targets', () => {
    function stateWithRuntimeOwnedAuthority() {
      return {
        ...stateWithGenerations(),
        runtimeOwnedSshConnectionGenerations: new Map([['runtime-ssh-vm-1', 7]])
      }
    }

    const runtimeOwnedExpectation = {
      expectedExecutionHostId: 'ssh:runtime-ssh-vm-1',
      expectedSshTargetId: 'runtime-ssh-vm-1',
      expectedSshConnectionGeneration: 7
    }

    it('resolves the fallback whether the runtime id is omitted, undefined or null', () => {
      const state = stateWithRuntimeOwnedAuthority()

      expect(captureDirectSshMutationExpectation(state, 'runtime-ssh-vm-1')).toEqual(
        runtimeOwnedExpectation
      )
      expect(captureDirectSshMutationExpectation(state, 'runtime-ssh-vm-1', undefined)).toEqual(
        runtimeOwnedExpectation
      )
      expect(captureDirectSshMutationExpectation(state, 'runtime-ssh-vm-1', null)).toEqual(
        runtimeOwnedExpectation
      )
    })

    it('never lends the local authority to a HUB-scoped lookup', () => {
      expect(() =>
        captureDirectSshMutationExpectation(
          stateWithRuntimeOwnedAuthority(),
          'runtime-ssh-vm-1',
          'hub-1'
        )
      ).toThrow("Couldn't verify the SSH connection")
    })

    it('fails closed while the authority is unpublished', () => {
      expect(() =>
        captureDirectSshMutationExpectation(stateWithGenerations(), 'runtime-ssh-vm-1')
      ).toThrow("Couldn't verify the SSH connection")
    })
  })
})
