import { describe, expect, it } from 'vitest'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getRemoteConnectionIdForWorktree,
  worktreeUsesRemoteConnection,
  worktreeUsesWslPath
} from './terminal-workspace-routing'

type RoutingState = Parameters<typeof worktreeUsesRemoteConnection>[0]

function state(overrides: Partial<RoutingState> = {}): RoutingState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    worktreesByRepo: {},
    ...overrides
  } as RoutingState
}

describe('terminal workspace routing', () => {
  it('resolves a canonical SSH key from its repo when the worktree catalog is cold', () => {
    const rawWorktreeId = 'repo-ssh::/srv/project'
    const canonicalKey = worktreeWorkspaceKey(rawWorktreeId)
    const routingState = state({
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-1' } as never]
    })

    expect(worktreeUsesRemoteConnection(routingState, canonicalKey)).toBe(true)
    expect(getRemoteConnectionIdForWorktree(routingState, canonicalKey)).toBe('ssh-1')
  })

  it('resolves a canonical key against the raw worktree path for WSL routing', () => {
    const rawWorktreeId = 'repo-local:://wsl.localhost/Ubuntu/home/project'
    const canonicalKey = worktreeWorkspaceKey(rawWorktreeId)
    const routingState = state({
      worktreesByRepo: {
        'repo-local': [
          {
            id: rawWorktreeId,
            repoId: 'repo-local',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\project'
          } as never
        ]
      }
    })

    expect(worktreeUsesWslPath(routingState, canonicalKey)).toBe(true)
  })

  it('fails closed when a cold canonical key has colliding local and SSH repo owners', () => {
    const rawWorktreeId = 'repo-collision::/remote/worktree'
    const canonicalKey = worktreeWorkspaceKey(rawWorktreeId)
    const routingState = state({
      repos: [
        { id: 'repo-collision', connectionId: null, executionHostId: 'local' } as never,
        { id: 'repo-collision', connectionId: 'ssh-1' } as never
      ]
    })

    expect(worktreeUsesRemoteConnection(routingState, canonicalKey)).toBe(false)
    expect(getRemoteConnectionIdForWorktree(routingState, canonicalKey)).toBeNull()
  })

  it('fails closed when loaded worktree rows collide across hosts', () => {
    const rawWorktreeId = 'repo-collision::/same-path'
    const canonicalKey = worktreeWorkspaceKey(rawWorktreeId)
    const routingState = state({
      repos: [
        { id: 'repo-collision', connectionId: null, executionHostId: 'local' } as never,
        { id: 'repo-collision', connectionId: 'ssh-1' } as never
      ],
      worktreesByRepo: {
        'repo-collision': [
          { id: rawWorktreeId, repoId: 'repo-collision', path: '/local/path' } as never,
          {
            id: rawWorktreeId,
            repoId: 'repo-collision',
            path: '/remote/path',
            hostId: 'ssh:ssh-1'
          } as never
        ]
      }
    })

    expect(worktreeUsesRemoteConnection(routingState, canonicalKey)).toBe(false)
    expect(getRemoteConnectionIdForWorktree(routingState, canonicalKey)).toBeNull()
    expect(worktreeUsesWslPath(routingState, canonicalKey)).toBe(false)
  })

  it('fails closed for malformed scoped keys', () => {
    const routingState = state({ repos: [{ id: 'repo-ssh', connectionId: 'ssh-1' } as never] })

    expect(worktreeUsesRemoteConnection(routingState, 'worktree:')).toBe(false)
    expect(getRemoteConnectionIdForWorktree(routingState, 'worktree:')).toBeNull()
    expect(worktreeUsesWslPath(routingState, 'worktree:')).toBe(false)
    expect(worktreeUsesRemoteConnection(routingState, 'worktree:repo-ssh')).toBe(false)
    expect(getRemoteConnectionIdForWorktree(routingState, 'worktree:repo-ssh')).toBeNull()
  })
})
