import { describe, expect, it, vi } from 'vitest'
import { beginHostQualifiedRemoval } from './host-qualified-worktree-removal'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'

const WORKTREE_ID = 'repo1::/shared/workspace/path'

/** Early refusal bypasses removal’s clearing catch; clear optimistic deleting state here or its spinner outlives the 10-second toast. */
// Confirmed hosts resolve directly; unresolved-owner refusal is reached only by hostless callers.
describe('beginHostQualifiedRemoval refusals clear the delete state', () => {
  function makeGet(clearWorktreeDeleteState: ReturnType<typeof vi.fn>) {
    // Minimal store surface: no worktrees, so no route can resolve for MISSING_HOST.
    return () =>
      ({
        clearWorktreeDeleteState,
        allWorktrees: () => [],
        worktreesByRepo: {},
        repos: [],
        detectedWorktreesByRepo: {},
        settings: {},
        sshConnectionStates: new Map(),
        sshTargetLabels: new Map(),
        workspaceCleanupScan: null
      }) as never
  }

  it('clears when no route resolves and no host was confirmed', () => {
    const clearWorktreeDeleteState = vi.fn()
    const start = beginHostQualifiedRemoval(
      makeGet(clearWorktreeDeleteState),
      WORKTREE_ID,
      null,
      false
    )

    expect(start.ok).toBe(false)
    expect(clearWorktreeDeleteState).toHaveBeenCalledWith(WORKTREE_ID)
  })

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

  // Folder workspaces fail closed on a stale id by design, so a row whose folder record is gone
  // refuses instead of routing.
  it('clears when a folder workspace id no longer has an owner', () => {
    const clearWorktreeDeleteState = vi.fn()
    const folderId = folderWorkspaceKey('fw-removed')
    const start = beginHostQualifiedRemoval(
      makeRoutedGet(clearWorktreeDeleteState, {
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        folderWorkspaces: []
      }),
      folderId,
      null,
      false
    )

    expect(start.ok).toBe(false)
    expect(clearWorktreeDeleteState).toHaveBeenCalledWith(folderId)
  })
})
