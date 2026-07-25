import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveTerminalWorktreeRoute } from './terminal-worktree-route'

function localState(overrides: Partial<AppState> = {}): AppState {
  return {
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1', hostId: 'local' }] },
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    ...overrides
  } as unknown as AppState
}

describe('resolveTerminalWorktreeRoute focused host', () => {
  it('routes a focused-host copy when the same worktree id is projected on two hosts (#10491)', () => {
    const state = localState({
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
      worktreesByRepo: {
        'repo-1': [
          { id: 'repo-1::/w', repoId: 'repo-1', hostId: 'local' },
          {
            id: 'repo-1::/w',
            repoId: 'repo-1',
            hostId: 'ssh:private-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      }
    } as unknown as Partial<AppState>)
    expect(resolveTerminalWorktreeRoute(state, 'repo-1::/w')).toEqual({
      runtimeEnvironmentId: 'hub-a'
    })
  })

  it('fails closed when multi-host projections share an id and focus matches none (#10491)', () => {
    const state = localState({
      settings: { activeRuntimeEnvironmentId: 'hub-c' },
      runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }, { id: 'hub-c' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::/w',
            repoId: 'repo-1',
            hostId: 'ssh:private-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          },
          {
            id: 'repo-1::/w',
            repoId: 'repo-1',
            hostId: 'ssh:private-b',
            runtimeOwnerEnvironmentId: 'hub-b'
          }
        ]
      }
    } as unknown as Partial<AppState>)
    expect(resolveTerminalWorktreeRoute(state, 'repo-1::/w')).toBeNull()
  })
})
