import { describe, expect, it, vi } from 'vitest'
import { beginHostQualifiedRemoval } from './host-qualified-worktree-removal'
import '../../../../../../shared/workspace-scope'

const WORKTREE_ID = 'repo1::/shared/workspace/path'

/** Early refusal bypasses removal’s clearing catch; clear optimistic deleting state here or its spinner outlives the 10-second toast. */
// Confirmed hosts resolve directly; unresolved-owner refusal is reached only by hostless callers.
describe('beginHostQualifiedRemoval refusals clear the delete state', () => {
  // Use populated unresolved-owner states too; an empty fixture proves clear but not real-user reachability.
  function makeRoutedGet(
    clearWorktreeDeleteState: ReturnType<typeof vi.fn>,
    overrides: Record<string, unknown>
  ) {
    return () =>
      ({
        clearWorktreeDeleteState,
        allWorktrees: () => [],
        worktreesByRepo: {},
        repos: [],
        detectedWorktreesByRepo: {},
        settings: {},
        runtimeEnvironments: [],
        folderWorkspaces: [],
        projectGroups: [],
        sshConnectionStates: new Map(),
        sshTargetLabels: new Map(),
        workspaceCleanupScan: null,
        ...overrides
      }) as never
  }

  // Unstamped legacy repos are local regardless of runtime focus; server rows get host stamps at ingest.
  it('routes a hostless legacy worktree locally, never through the focused server', () => {
    const clearWorktreeDeleteState = vi.fn()
    const start = beginHostQualifiedRemoval(
      makeRoutedGet(clearWorktreeDeleteState, {
        repos: [{ id: 'repo1', connectionId: null, executionHostId: undefined }],
        worktreesByRepo: { repo1: [{ id: WORKTREE_ID, repoId: 'repo1' }] },
        settings: { activeRuntimeEnvironmentId: 'env-a' },
        runtimeEnvironments: [{ id: 'env-a' }, { id: 'env-b' }]
      }),
      WORKTREE_ID,
      null,
      false
    )

    expect(start).toMatchObject({
      ok: true,
      removalRoute: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
    expect(clearWorktreeDeleteState).not.toHaveBeenCalled()
  })
})
