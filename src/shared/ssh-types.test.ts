import { describe, expect, it } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from './ssh-types'

describe('SSH types', () => {
  it('SshConnectionState composes correctly', () => {
    const state: SshConnectionState = {
      targetId: 'target-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'provider-a' as SshProviderEpoch,
      connectionGeneration: 1
    }
    expect(state.status).toBe('connected')
    expect(state.error).toBeNull()
    expect(state.providerEpoch).toBe('provider-a')
    expect(state.connectionGeneration).toBe(1)
  })
})
