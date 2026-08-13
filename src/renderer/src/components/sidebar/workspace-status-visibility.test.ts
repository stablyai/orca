import { describe, expect, it } from 'vitest'
import {
  getEffectiveHiddenWorkspaceStatusIds,
  isWorkspaceStatusHidden
} from './workspace-status-visibility'
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

  it('shows everything again once every surviving status is hidden', () => {
    // Reachable by deleting the one status the user had left visible.
    const hiddenEverything = STATUSES.map((status) => status.id)

    expect(isWorkspaceStatusHidden({ workspaceStatus: 'todo' }, hiddenEverything, STATUSES)).toBe(
      false
    )
  })
})

describe('getEffectiveHiddenWorkspaceStatusIds', () => {
  const STATUSES = [...DEFAULT_WORKSPACE_STATUSES]

  it('drops ids of statuses that no longer exist', () => {
    expect(getEffectiveHiddenWorkspaceStatusIds(['completed', 'deleted-id'], STATUSES)).toEqual([
      'completed'
    ])
  })

  it('clears the filter when it would hide every status', () => {
    expect(
      getEffectiveHiddenWorkspaceStatusIds(
        STATUSES.map((status) => status.id),
        STATUSES
      )
    ).toEqual([])
  })
})
