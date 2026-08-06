import { describe, expect, it } from 'vitest'
import type { WorkspaceLineage } from './types'
import {
  projectWorkspaceLineageRecord,
  projectWorkspaceLineageToWorktreeLineage
} from './workspace-lineage-worktree-projection'

const worktreeLineage: WorkspaceLineage = {
  childWorkspaceKey: 'worktree:repo::/child',
  childInstanceId: 'child-instance',
  parentWorkspaceKey: 'worktree:repo::/parent',
  parentInstanceId: 'parent-instance',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 42
}

describe('workspace lineage worktree projection', () => {
  it('projects worktree-to-worktree lineage for sidebar nesting', () => {
    expect(projectWorkspaceLineageToWorktreeLineage(worktreeLineage)).toEqual({
      worktreeId: 'repo::/child',
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: 'repo::/parent',
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 42
    })
  })

  it('does not project folder lineage into the worktree-only tree', () => {
    expect(
      projectWorkspaceLineageToWorktreeLineage({
        ...worktreeLineage,
        parentWorkspaceKey: 'folder:project-1',
        parentInstanceId: null
      })
    ).toBeNull()
  })

  it('indexes projected lineage by child worktree id', () => {
    expect(
      projectWorkspaceLineageRecord({ [worktreeLineage.childWorkspaceKey]: worktreeLineage })
    ).toHaveProperty('repo::/child.parentWorktreeId', 'repo::/parent')
  })
})
