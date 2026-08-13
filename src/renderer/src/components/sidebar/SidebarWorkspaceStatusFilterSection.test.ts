import { describe, expect, it } from 'vitest'
import { toggleHiddenWorkspaceStatusId } from './SidebarWorkspaceStatusFilterSection'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'

const STATUSES = [...DEFAULT_WORKSPACE_STATUSES]

describe('toggleHiddenWorkspaceStatusId', () => {
  it('hides an unchecked status and shows it again on re-check', () => {
    const hidden = toggleHiddenWorkspaceStatusId([], STATUSES, 'completed')
    expect(hidden).toEqual(['completed'])
    expect(toggleHiddenWorkspaceStatusId(hidden, STATUSES, 'completed')).toEqual([])
  })

  it('refuses to hide the last visible status', () => {
    const allButTodo = STATUSES.filter((status) => status.id !== 'todo').map((status) => status.id)

    expect(toggleHiddenWorkspaceStatusId(allButTodo, STATUSES, 'todo')).toEqual(allButTodo)
  })
})
