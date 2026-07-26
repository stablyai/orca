import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { resolveTerminalWorktreeRoute } from './terminal-worktree-route'

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
