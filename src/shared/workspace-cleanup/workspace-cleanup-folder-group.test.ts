// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupEvaluation } from './workspace-cleanup-evaluation'
import { applyFolderWorkspaceCleanupGroupVeto } from './workspace-cleanup-folder-group'

const remove: WorkspaceCleanupEvaluation = { action: 'delete', reason: 'merged' }
const keepDirty: WorkspaceCleanupEvaluation = {
  action: 'keep',
  cause: 'uncommitted-changes'
}

describe('applyFolderWorkspaceCleanupGroupVeto', () => {
  it('keeps every sibling when one folder member must keep', () => {
    const evaluations = applyFolderWorkspaceCleanupGroupVeto([
      { folderParentKey: 'folder-1', evaluation: remove },
      { folderParentKey: 'folder-1', evaluation: keepDirty }
    ])
    expect(evaluations).toEqual([
      { action: 'keep', cause: 'folder-mate-in-use' },
      // The member that raised the veto keeps its own, more specific cause.
      keepDirty
    ])
  })

  it('removes every member when all of them are removable', () => {
    const evaluations = applyFolderWorkspaceCleanupGroupVeto([
      { folderParentKey: 'folder-1', evaluation: remove },
      { folderParentKey: 'folder-1', evaluation: { action: 'delete', reason: 'inactive' } }
    ])
    expect(evaluations).toEqual([remove, { action: 'delete', reason: 'inactive' }])
  })

  it('leaves workspaces outside any folder workspace untouched', () => {
    const evaluations = applyFolderWorkspaceCleanupGroupVeto([
      { evaluation: remove },
      { folderParentKey: 'folder-1', evaluation: keepDirty }
    ])
    expect(evaluations).toEqual([remove, keepDirty])
  })

  it('does not cross groups', () => {
    const evaluations = applyFolderWorkspaceCleanupGroupVeto([
      { folderParentKey: 'folder-1', evaluation: remove },
      { folderParentKey: 'folder-2', evaluation: keepDirty }
    ])
    expect(evaluations).toEqual([remove, keepDirty])
  })
})
