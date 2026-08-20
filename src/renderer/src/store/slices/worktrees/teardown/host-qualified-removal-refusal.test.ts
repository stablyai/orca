import { describe, expect, it, vi } from 'vitest'
import { beginHostQualifiedRemoval } from './host-qualified-worktree-removal'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'

const WORKTREE_ID = 'repo1::/shared/workspace/path'

/**
 * Callers mark rows deleting up front for immediate sidebar feedback
 * (worktree-delete-execution.ts). These refusals return BEFORE removeWorktree's
 * try/catch, which is the only other place that clears the flag — so without an
 * explicit clear the workspace keeps its "Deleting…" spinner indefinitely, long
 * after the 10s failure toast has gone.
 */
// Note: with a confirmed host the route resolves from the host id alone, so this refusal is
// reached on the UNQUALIFIED path — a caller that names no host and has no resolvable owner.
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

  // The store above is deliberately empty, which proves the clear but not that a real user can
  // land here. These two cases route through populated state a user actually has, and still
  // resolve to no route — the states that leave the row spinning in the product.
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

  // A hostless row (folder-workspace meta never sets hostId, and runtime rows omit the field
  // when the repo is unresolved) plus more than one saved runtime environment trips the legacy
  // single-runtime gate in resolveWorktreeOperationRouteResult, which returns `missing`.
  it('clears when a known worktree has no host and the legacy runtime is ambiguous', () => {
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

    expect(start.ok).toBe(false)
    expect(clearWorktreeDeleteState).toHaveBeenCalledWith(WORKTREE_ID)
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
