import { describe, expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { buildActiveConnectionIdsAtShutdown } from './workspace-session-reconnect-targets'

function connected(targetId: string): [string, SshConnectionState] {
  return [targetId, { targetId, status: 'connected', error: null, reconnectAttempt: 0 }]
}

describe('buildActiveConnectionIdsAtShutdown', () => {
  it('never asks startup to dial an Orca-owned target', () => {
    const owned = ['runtime-ssh-vm-1', 'machine-0123']
    const snapshot = {
      sshConnectionStates: new Map([connected('ssh-user'), ...owned.map(connected)])
    }
    const remoteSessions = Object.fromEntries(
      owned.map((id, index) => [`tab-${index}`, toAppSshPtyId(id, 'pty-1')])
    )
    expect(
      buildActiveConnectionIdsAtShutdown(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only sshConnectionStates.
        snapshot as WorkspaceSessionSnapshot,
        remoteSessions
      )
    ).toEqual(['ssh-user'])
  })
})
