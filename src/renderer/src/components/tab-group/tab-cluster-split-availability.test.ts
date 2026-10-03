import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getTabClusterSplitBlocker } from './tab-cluster-split-availability'

const WT = 'repo1::/tmp/cluster-split'

describe('local cluster split availability', () => {
  it('allows local workspaces even while a remote environment is focused', () => {
    expect(
      getTabClusterSplitBlocker(
        {
          activeWorktreeId: WT,
          activeWorkspaceExecutionHostId: 'local',
          repos: [{ id: 'repo1', executionHostId: 'local' }],
          settings: { activeRuntimeEnvironmentId: 'remote' }
        },
        WT
      )
    ).toBeNull()
  })

  it('rejects workspaces whose tab moves are mirrored to an active host', () => {
    expect(
      getTabClusterSplitBlocker(
        {
          activeWorktreeId: WT,
          activeWorkspaceExecutionHostId: 'runtime:remote',
          repos: [{ id: 'repo1', executionHostId: 'local' }]
        },
        WT
      )
    ).toBe('remote-server')
  })

  it('rejects a projected runtime owner even when its repo is local', () => {
    expect(
      getTabClusterSplitBlocker(
        {
          repos: [{ id: 'repo1', executionHostId: 'local' }],
          worktreesByRepo: {
            repo1: [
              { id: WT, repoId: 'repo1', hostId: 'local', runtimeOwnerEnvironmentId: 'remote' }
            ]
          }
        },
        WT
      )
    ).toBe('remote-server')
  })

  it('rejects new splits in the single-pane floating strip', () => {
    expect(
      getTabClusterSplitBlocker(
        {
          activeWorktreeId: WT,
          activeWorkspaceExecutionHostId: 'runtime:remote',
          settings: { activeRuntimeEnvironmentId: 'remote' }
        },
        FLOATING_TERMINAL_WORKTREE_ID
      )
    ).toBe('floating-panel')
  })
})
