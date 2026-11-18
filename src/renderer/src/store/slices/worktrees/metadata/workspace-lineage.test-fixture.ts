import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'

export function makeLineage(overrides: Partial<WorktreeLineage> = {}): WorktreeLineage {
  return {
    worktreeId: 'repo1::/path/child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: 'repo1::/path/parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}
export function makeWorkspaceLineage(overrides: Partial<WorkspaceLineage> = {}): WorkspaceLineage {
  return {
    childWorkspaceKey: 'worktree:repo1::/path/child',
    childInstanceId: 'child-instance',
    parentWorkspaceKey: 'folder:folder-1',
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 2,
    ...overrides
  }
}
