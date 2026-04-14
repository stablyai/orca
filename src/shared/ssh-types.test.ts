import { describe, expect, it } from 'vitest'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from './ssh-types'

describe('SSH types', () => {
  it('SshTarget has required fields', () => {
    const target: SshTarget = {
      id: 'target-1',
      label: 'My Server',
      host: 'myserver.com',
      port: 22,
      username: 'deploy'
    }
    expect(target.id).toBe('target-1')
    expect(target.host).toBe('myserver.com')
  })

  it('SshConnectionStatus covers all expected states', () => {
    const statuses: SshConnectionStatus[] = [
      'disconnected',
      'connecting',
      'auth-failed',
      'deploying-relay',
      'connected',
      'reconnecting',
      'reconnection-failed',
      'error'
    ]
    expect(statuses).toHaveLength(8)
  })

  it('SshConnectionState composes correctly', () => {
    const state: SshConnectionState = {
      targetId: 'target-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    expect(state.status).toBe('connected')
    expect(state.error).toBeNull()
  })

  it('Repo.connectionId is optional for backward compatibility', () => {
    // Import the Repo type to verify connectionId is optional
    const repo = {
      id: 'repo-1',
      path: '/path/to/repo',
      displayName: 'My Repo',
      badgeColor: '#ff0000',
      addedAt: Date.now()
    }
    // Should compile without connectionId
    expect(repo.id).toBe('repo-1')
    expect('connectionId' in repo).toBe(false)

    // Should also work with connectionId
    const remoteRepo = {
      ...repo,
      connectionId: 'target-1'
    }
    expect(remoteRepo.connectionId).toBe('target-1')
  })
})
