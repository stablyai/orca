import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { runtimeStatuses } from './browser-slice-test-harness'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import { buildAgentLaunchRouteInput, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'

const id = 'repo1::/path/twin'
function setup() {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id, repoId: 'repo1', path: '/path/twin', hostId: 'local' }),
        makeWorktree({
          id,
          repoId: 'repo1',
          path: '/path/twin',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    },
    runtimeStatusByEnvironmentId: runtimeStatuses(['browser.screencast.v1'])
  })
  return store
}

describe('captured sidebar workspace copy', () => {
  it('reads agent detection and launch capabilities from the selected runtime while the local twin is active', () => {
    const state = setup().getState()
    expect(getAgentDetectionTargetKeyForWorktree(state, id, 'runtime:env-1')).toBe(
      'runtime:env-1:repo1%3A%3A%2Fpath%2Ftwin'
    )
    const input = buildAgentLaunchRouteInput(state, {
      agent: 'codex',
      workspace: worktreeLaunchWorkspace(id, 'runtime:env-1')
    })
    expect(input.executionHostId).toBe('runtime:env-1')
    expect(input.hostCapabilities).toEqual(['browser.screencast.v1'])
  })
  it('checks the selected runtime browser capability instead of the local twin on a web client', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    try {
      const state = setup().getState()
      expect(
        getWorkspaceClientCreationActionPolicy(state, id, 'runtime:env-1')['managed-browser']
      ).toEqual({ state: 'enabled', provider: 'paired-runtime' })
      expect(
        getWorkspaceClientCreationActionPolicy(state, id, 'runtime:absent')['managed-browser'].state
      ).toBe('hidden')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
