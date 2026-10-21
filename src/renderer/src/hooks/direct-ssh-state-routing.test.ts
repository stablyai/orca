// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { directSshAuthorityFromConnectionState } from './direct-ssh-state-routing'

function authority(epoch = 'epoch-a'): DirectSshAuthority {
  return {
    targetId: 'target-a',
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: 1
  }
}

describe('directSshAuthorityFromConnectionState', () => {
  it('rejects mismatched keys and malformed partial authority', () => {
    expect(
      directSshAuthorityFromConnectionState('other-target', {
        ...authority(),
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    ).toBeNull()
    expect(
      directSshAuthorityFromConnectionState('target-a', {
        targetId: 'target-a',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        connectionGeneration: 1
      })
    ).toBeNull()
  })
})
