import { describe, expect, it } from 'vitest'
import {
  getExecutionHostIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

// Regression guard for the #8484 residual (follow-up to #8509): the same
// project registered on BOTH local desktop and a paired runtime keeps several
// repo records under one repoId. A worktree with no explicit hostId (legacy /
// pre-project-host metadata) must resolve its owner from its own filesystem
// path — not from whichever same-id repo record happens to be indexed first,
// which makes routing depend on record order.
const LOCAL_WORKTREE = 'proj::/Users/me/GitHub/.orca-worktrees/proj-wt'
const RUNTIME_WORKTREE = 'proj::/home/user/orca-worktrees/proj-wt'

function buildHostSplitState(
  activeRuntimeEnvironmentId: string | null,
  repoOrder: 'local-first' | 'runtime-first' | 'legacy-first'
): WorktreeRuntimeOwnerState {
  const localRepo = {
    id: 'proj',
    connectionId: null,
    executionHostId: 'local' as const,
    path: '/Users/me/GitHub/proj'
  }
  const runtimeRepo = {
    id: 'proj',
    connectionId: null,
    executionHostId: 'runtime:env-1' as const,
    path: '/home/user/proj'
  }
  const legacyRepo = { id: 'proj', connectionId: null, executionHostId: null, path: '' }
  const repos =
    repoOrder === 'local-first'
      ? [localRepo, runtimeRepo]
      : repoOrder === 'runtime-first'
        ? [runtimeRepo, localRepo]
        : [legacyRepo, localRepo, runtimeRepo]
  return {
    settings: { activeRuntimeEnvironmentId },
    repos,
    worktreesByRepo: {
      proj: [
        { id: LOCAL_WORKTREE, repoId: 'proj' },
        { id: RUNTIME_WORKTREE, repoId: 'proj' }
      ]
    }
  }
}

describe('#8484 host-split owner resolution for hostless worktrees', () => {
  it('explicit owner resolution does not depend on repo record order', () => {
    for (const order of ['local-first', 'runtime-first'] as const) {
      const state = buildHostSplitState('env-1', order)
      expect(getExplicitRuntimeEnvironmentIdForWorktree(state, LOCAL_WORKTREE)).toBeNull()
      expect(getExplicitRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
    }
  })

  it('routes each host-split worktree by its own path while the runtime is default', () => {
    const state = buildHostSplitState('env-1', 'runtime-first')
    expect(getRuntimeEnvironmentIdForWorktree(state, LOCAL_WORKTREE)).toBeNull()
    expect(getExecutionHostIdForWorktree(state, LOCAL_WORKTREE)).toBe('local')
    expect(getRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
    expect(getExecutionHostIdForWorktree(state, RUNTIME_WORKTREE)).toBe('runtime:env-1')
  })

  it('routes each host-split worktree by its own path while local is default', () => {
    const state = buildHostSplitState(null, 'local-first')
    expect(getRuntimeEnvironmentIdForWorktree(state, LOCAL_WORKTREE)).toBeNull()
    expect(getRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
  })

  it('still resolves both worktrees past a legacy null-host record for the same repoId', () => {
    const state = buildHostSplitState('env-1', 'legacy-first')
    expect(getRuntimeEnvironmentIdForWorktree(state, LOCAL_WORKTREE)).toBeNull()
    expect(getExecutionHostIdForWorktree(state, LOCAL_WORKTREE)).toBe('local')
    expect(getRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
  })

  it('an explicit worktree hostId still wins over path inference', () => {
    const state = buildHostSplitState('env-1', 'local-first')
    const withHostId: WorktreeRuntimeOwnerState = {
      ...state,
      worktreesByRepo: {
        proj: [
          { id: LOCAL_WORKTREE, repoId: 'proj', hostId: 'runtime:env-1' },
          { id: RUNTIME_WORKTREE, repoId: 'proj', hostId: 'local' }
        ]
      }
    }
    expect(getRuntimeEnvironmentIdForWorktree(withHostId, LOCAL_WORKTREE)).toBe('env-1')
    expect(getExplicitRuntimeEnvironmentIdForWorktree(withHostId, LOCAL_WORKTREE)).toBe('env-1')
    expect(getRuntimeEnvironmentIdForWorktree(withHostId, RUNTIME_WORKTREE)).toBeNull()
  })

  it('a cross-host path tie keeps the prior first-indexed resolution', () => {
    // Both hosts registered under the same absolute path (e.g. a self-paired
    // runtime on one machine): scores tie, so behavior must not change.
    const state: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: null },
      repos: [
        { id: 'proj', connectionId: null, executionHostId: 'local', path: '/data/proj' },
        { id: 'proj', connectionId: null, executionHostId: 'runtime:env-1', path: '/data/proj' }
      ],
      worktreesByRepo: { proj: [{ id: 'proj::/data/proj-wt', repoId: 'proj' }] }
    }
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, 'proj::/data/proj-wt')).toBeNull()
    expect(getExecutionHostIdForWorktree(state, 'proj::/data/proj-wt')).toBe('local')
  })

  it('single-host repos resolve exactly as before', () => {
    const state: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      repos: [{ id: 'solo', connectionId: null, executionHostId: 'runtime:solo-env' }],
      worktreesByRepo: { solo: [{ id: 'solo::/srv/solo-wt', repoId: 'solo' }] }
    }
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, 'solo::/srv/solo-wt')).toBe('solo-env')
    expect(getRuntimeEnvironmentIdForWorktree(state, 'solo::/srv/solo-wt')).toBe('solo-env')
  })
})
