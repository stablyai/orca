import { describe, expect, it } from 'vitest'
import {
  canUseRepoBackedComposerSources,
  getSelectedRepoSshGate,
  isSshConnectInProgress
} from './new-workspace-ssh-gate'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

describe('new workspace SSH gate', () => {
  it('does not gate local repos', () => {
    expect(getSelectedRepoSshGate({ connectionId: null, status: 'disconnected' })).toEqual({
      selectedRepoConnectionId: null,
      selectedRepoSshStatus: null,
      selectedRepoRequiresConnection: false,
      selectedRepoConnectInProgress: false
    })
    expect(canUseRepoBackedComposerSources({ connectionId: null, status: null })).toBe(true)
  })

  it('treats connected SSH repos as ready', () => {
    expect(getSelectedRepoSshGate({ connectionId: 'ssh-1', status: 'connected' })).toEqual({
      selectedRepoConnectionId: 'ssh-1',
      selectedRepoSshStatus: 'connected',
      selectedRepoRequiresConnection: false,
      selectedRepoConnectInProgress: false
    })
    expect(canUseRepoBackedComposerSources({ connectionId: 'ssh-1', status: 'connected' })).toBe(
      true
    )
  })

  it('blocks missing and failed SSH states as connectable', () => {
    const blockedStatuses: (SshConnectionStatus | null)[] = [
      null,
      'disconnected',
      'auth-failed',
      'reconnection-failed',
      'error'
    ]

    for (const status of blockedStatuses) {
      expect(getSelectedRepoSshGate({ connectionId: 'ssh-1', status })).toMatchObject({
        selectedRepoConnectionId: 'ssh-1',
        selectedRepoSshStatus: status,
        selectedRepoRequiresConnection: true,
        selectedRepoConnectInProgress: false
      })
      expect(canUseRepoBackedComposerSources({ connectionId: 'ssh-1', status })).toBe(false)
    }
  })

  it('marks active SSH transitions as blocked and in progress', () => {
    const inProgressStatuses: SshConnectionStatus[] = [
      'connecting',
      'deploying-relay',
      'reconnecting'
    ]

    for (const status of inProgressStatuses) {
      expect(isSshConnectInProgress(status)).toBe(true)
      expect(getSelectedRepoSshGate({ connectionId: 'ssh-1', status })).toMatchObject({
        selectedRepoRequiresConnection: true,
        selectedRepoConnectInProgress: true
      })
    }
  })
})
