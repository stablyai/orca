import { describe, expect, it } from 'vitest'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/types'
import { getRepoHeaderCreateState } from './repo-header-create-state'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

describe('repo header create state', () => {
  it('allows local git repos', () => {
    expect(
      getRepoHeaderCreateState({
        repo: makeRepo(),
        label: 'orca',
        sshStatus: null
      })
    ).toEqual({
      disabled: false,
      tooltip: 'Create workspace for orca',
      ariaLabel: 'Create workspace for orca',
      requiresSshReconnect: false
    })
  })

  it('disables folder repos', () => {
    expect(
      getRepoHeaderCreateState({
        repo: makeRepo({ kind: 'folder' }),
        label: 'docs',
        sshStatus: null
      })
    ).toMatchObject({
      disabled: true,
      tooltip: 'docs is opened as a folder',
      requiresSshReconnect: false
    })
  })

  it('allows connected SSH repos', () => {
    expect(
      getRepoHeaderCreateState({
        repo: makeRepo({ connectionId: 'ssh-1' }),
        label: 'remote',
        sshStatus: 'connected'
      })
    ).toMatchObject({
      disabled: false,
      tooltip: 'Create workspace for remote',
      requiresSshReconnect: false
    })
  })

  it('disables SSH repos while relay providers are unavailable', () => {
    const blockedStatuses: (SshConnectionStatus | null)[] = [
      null,
      'disconnected',
      'reconnecting',
      'error'
    ]

    for (const sshStatus of blockedStatuses) {
      expect(
        getRepoHeaderCreateState({
          repo: makeRepo({ connectionId: 'ssh-1' }),
          label: 'remote',
          sshStatus
        })
      ).toEqual({
        disabled: true,
        tooltip: 'Reconnect SSH target before creating workspaces',
        ariaLabel: 'Reconnect SSH target before creating workspaces for remote',
        requiresSshReconnect: true
      })
    }
  })
})
