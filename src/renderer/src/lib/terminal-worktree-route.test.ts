import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveTerminalHostOwnership,
  resolveTerminalWorktreeRoute
} from './terminal-worktree-route'

const EPHEMERAL_ID = brandEphemeralSetupTerminalWorktreeId(
  'settings-mobile-emulator-orca-cli-skill-terminal'
)

// A realistic local-only store: one real repo/worktree, hydrated empty runtime catalog.
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

describe('resolveTerminalWorktreeRoute', () => {
  it('keeps the floating terminal local', () => {
    expect(resolveTerminalWorktreeRoute(localState(), FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      runtimeEnvironmentId: null
    })
  })

  it('routes an ephemeral setup terminal locally when no runtime is active', () => {
    // Regression: previously returned null (unroutable), producing the
    // "Workspace identity is ambiguous across hosts" error transport (#9994 fallout).
    expect(resolveTerminalWorktreeRoute(localState(), EPHEMERAL_ID)).toEqual({
      runtimeEnvironmentId: null
    })
  })

  it('scopes an ephemeral setup terminal to the single active runtime for remote skill installs', () => {
    const state = localState({
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      runtimeEnvironments: [{ id: 'hub-a' }]
    } as unknown as Partial<AppState>)
    expect(resolveTerminalWorktreeRoute(state, EPHEMERAL_ID)).toEqual({
      runtimeEnvironmentId: 'hub-a'
    })
  })

  it('does not guess a runtime for an ephemeral setup terminal when the focus is ambiguous', () => {
    const state = localState({
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }]
    } as unknown as Partial<AppState>)
    expect(resolveTerminalWorktreeRoute(state, EPHEMERAL_ID)).toEqual({
      runtimeEnvironmentId: null
    })
  })

  it('resolves a known local worktree', () => {
    expect(resolveTerminalWorktreeRoute(localState(), 'repo-1::/w')).toEqual({
      runtimeEnvironmentId: null
    })
  })

  it('still fails a genuinely unknown/stale worktree closed', () => {
    expect(resolveTerminalWorktreeRoute(localState(), 'repo-9::/stale')).toBeNull()
  })

  it('does not treat a folder workspace as an unresolved worktree', () => {
    expect(resolveTerminalWorktreeRoute(localState(), folderWorkspaceKey('abc-123'))).not.toBeNull()
  })
})

// STA-2639: teardown must follow the PTY's real host while spawn stays free to prefer a focused
// runtime. Both purposes are asserted per shape so they cannot silently drift into agreement.
describe('resolveTerminalHostOwnership teardown', () => {
  const focusedState = (overrides: Partial<AppState> = {}): AppState =>
    localState({
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      runtimeEnvironments: [{ id: 'hub-a' }],
      ...overrides
    } as unknown as Partial<AppState>)

  it('scopes an ephemeral setup terminal to the runtime for spawn but not for teardown', () => {
    const state = focusedState()
    expect(resolveTerminalHostOwnership(state, EPHEMERAL_ID, 'spawn')).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'hub-a'
    })
    expect(resolveTerminalHostOwnership(state, EPHEMERAL_ID, 'teardown')).toEqual({
      kind: 'local-or-ssh',
      runtimeEnvironmentId: null
    })
  })

  it('keeps a plain local folder workspace local for teardown while a runtime is focused', () => {
    const state = focusedState({
      folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'pg-1', connectionId: null }],
      projectGroups: [{ id: 'pg-1', connectionId: null, executionHostId: null }]
    } as unknown as Partial<AppState>)
    expect(resolveTerminalHostOwnership(state, folderWorkspaceKey('fw-1'), 'teardown')).toEqual({
      kind: 'local-or-ssh',
      runtimeEnvironmentId: null
    })
  })

  it('keeps a HUB-owned folder workspace on its runtime for teardown', () => {
    const state = focusedState({
      folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'pg-1', connectionId: null }],
      projectGroups: [{ id: 'pg-1', connectionId: null, executionHostId: 'runtime:hub-a' }]
    } as unknown as Partial<AppState>)
    expect(resolveTerminalHostOwnership(state, folderWorkspaceKey('fw-1'), 'teardown')).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'hub-a'
    })
  })

  it('keeps a hostless worktree on the focused runtime for teardown too', () => {
    // Why: unlike the host-agnostic surfaces, an ownerless worktree row really does spawn on the
    // focused HUB, and its wake hint is `ssh:`-shaped — downgrading it would kill the wrong host.
    const state = focusedState({
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1' }] }
    } as unknown as Partial<AppState>)
    for (const purpose of ['spawn', 'teardown'] as const) {
      expect(resolveTerminalHostOwnership(state, 'repo-1::/w', purpose)).toEqual({
        kind: 'runtime',
        runtimeEnvironmentId: 'hub-a'
      })
    }
  })

  it('keeps an explicitly runtime-owned worktree on its runtime for teardown', () => {
    const state = focusedState({
      worktreesByRepo: {
        'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1', runtimeOwnerEnvironmentId: 'hub-a' }]
      }
    } as unknown as Partial<AppState>)
    expect(resolveTerminalHostOwnership(state, 'repo-1::/w', 'teardown')).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'hub-a'
    })
  })

  it('keeps an SSH-owned worktree killable by the paired client', () => {
    const state = localState({
      repos: [{ id: 'repo-1', connectionId: 'conn-1', executionHostId: 'ssh:conn-1' }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1', hostId: 'ssh:conn-1' }] }
    } as unknown as Partial<AppState>)
    expect(resolveTerminalHostOwnership(state, 'repo-1::/w', 'teardown')).toEqual({
      kind: 'local-or-ssh',
      runtimeEnvironmentId: null
    })
  })

  it('fails a worktree with unparseable host metadata closed', () => {
    // Why: a host string we cannot classify is not evidence of a local process.
    const state = localState({
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'nonsense:' }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1', hostId: 'nonsense:' }] }
    } as unknown as Partial<AppState>)
    for (const purpose of ['spawn', 'teardown'] as const) {
      expect(resolveTerminalHostOwnership(state, 'repo-1::/w', purpose)).toEqual({
        kind: 'unresolved',
        runtimeEnvironmentId: null
      })
    }
  })

  it('fails a missing worktree id closed for teardown', () => {
    expect(resolveTerminalHostOwnership(localState(), null, 'teardown')).toEqual({
      kind: 'unresolved',
      runtimeEnvironmentId: null
    })
  })
})
