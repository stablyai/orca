import { describe, expect, it } from 'vitest'
import { updateTerminalRemoteRuntimeRecoveryUiState } from './terminal-remote-runtime-recovery-ui-state'

describe('updateTerminalRemoteRuntimeRecoveryUiState', () => {
  it('tracks only recovery phases that need pane UI', () => {
    const recovering = updateTerminalRemoteRuntimeRecoveryUiState({}, 7, {
      phase: 'recovering',
      epoch: 2,
      attempt: 1
    })

    expect(recovering[7]?.phase).toBe('recovering')
    expect(
      updateTerminalRemoteRuntimeRecoveryUiState(recovering, 7, {
        phase: 'connected',
        epoch: 2,
        attempt: 0
      })
    ).toEqual({})
  })

  it('drops disconnected state when the owning pane closes', () => {
    const disconnected = updateTerminalRemoteRuntimeRecoveryUiState({}, 7, {
      phase: 'disconnected',
      epoch: 2,
      attempt: 4
    })

    expect(updateTerminalRemoteRuntimeRecoveryUiState(disconnected, 7, null)).toEqual({})
  })
})
