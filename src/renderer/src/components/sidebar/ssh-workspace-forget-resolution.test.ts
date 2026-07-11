import { describe, it, expect } from 'vitest'
import { resolveSshWorkspaceForget } from './ssh-workspace-forget-resolution'
import type { SshConnectionState } from '../../../../shared/ssh-types'

function stateMap(
  entries: Record<string, SshConnectionState['status']>
): Map<string, SshConnectionState> {
  return new Map(
    Object.entries(entries).map(([id, status]) => [
      id,
      { targetId: id, status, error: null, reconnectAttempt: 0 }
    ])
  )
}

describe('resolveSshWorkspaceForget', () => {
  it('returns not-ssh for a repo with no connectionId', () => {
    const result = resolveSshWorkspaceForget({
      repo: { connectionId: null },
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map()
    })
    expect(result.kind).toBe('not-ssh')
  })

  it('returns not-ssh for a runtime-owned target', () => {
    const result = resolveSshWorkspaceForget({
      repo: { connectionId: 'runtime-ssh-abc' },
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map()
    })
    expect(result.kind).toBe('not-ssh')
  })

  it('returns ghost when the target is no longer configured', () => {
    const result = resolveSshWorkspaceForget({
      repo: { connectionId: 'ssh-dead' },
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map() // ssh-dead not present -> ghost
    })
    expect(result).toEqual({ kind: 'ghost', targetId: 'ssh-dead' })
  })

  it('returns connected when the configured target is connected', () => {
    const result = resolveSshWorkspaceForget({
      repo: { connectionId: 'ssh-live' },
      sshConnectionStates: stateMap({ 'ssh-live': 'connected' }),
      sshTargetLabels: new Map([['ssh-live', 'Live']])
    })
    expect(result).toEqual({ kind: 'connected', targetId: 'ssh-live' })
  })

  it('returns disconnected when configured but not connected', () => {
    const result = resolveSshWorkspaceForget({
      repo: { connectionId: 'ssh-live' },
      sshConnectionStates: stateMap({ 'ssh-live': 'error' }),
      sshTargetLabels: new Map([['ssh-live', 'Live']])
    })
    expect(result).toEqual({ kind: 'disconnected', targetId: 'ssh-live', status: 'error' })
  })

  it('defaults to disconnected status when configured target has no live state', () => {
    const result = resolveSshWorkspaceForget({
      repo: { connectionId: 'ssh-live' },
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map([['ssh-live', 'Live']])
    })
    expect(result).toEqual({ kind: 'disconnected', targetId: 'ssh-live', status: 'disconnected' })
  })
})
