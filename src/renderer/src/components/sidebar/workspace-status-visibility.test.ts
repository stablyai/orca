import { describe, expect, it } from 'vitest'
import { isWorkspaceStatusHidden } from './workspace-status-visibility'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'

describe('isWorkspaceStatusHidden', () => {
  const STATUSES = [...DEFAULT_WORKSPACE_STATUSES]

  // Folder workspaces carry workspaceStatus but never reach the worktree
  // pipeline, so they share this predicate instead of a second copy.
  it('hides a folder workspace whose status the user unchecked', () => {
    expect(isWorkspaceStatusHidden({ workspaceStatus: 'completed' }, ['completed'], STATUSES)).toBe(
      true
    )
    expect(isWorkspaceStatusHidden({ workspaceStatus: 'todo' }, ['completed'], STATUSES)).toBe(
      false
    )
  })

  it('fails open with no hide-list or no status catalog', () => {
    expect(isWorkspaceStatusHidden({ workspaceStatus: 'completed' }, [], STATUSES)).toBe(false)
    expect(isWorkspaceStatusHidden({ workspaceStatus: 'completed' }, ['completed'], [])).toBe(false)
    expect(
      isWorkspaceStatusHidden({ workspaceStatus: 'completed' }, ['completed'], undefined)
    ).toBe(false)
  })
})
