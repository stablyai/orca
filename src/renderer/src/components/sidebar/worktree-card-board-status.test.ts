import { describe, expect, it } from 'vitest'

import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-status-defaults'
import { resolveWorktreeCardBoardStatus } from './worktree-card-board-status'

describe('resolveWorktreeCardBoardStatus', () => {
  it('badges a non-default status', () => {
    const status = resolveWorktreeCardBoardStatus(
      { workspaceStatus: 'in-review' },
      DEFAULT_WORKSPACE_STATUSES,
      'repo'
    )
    expect(status?.id).toBe('in-review')
  })

  it('badges todo, which is not the default lane', () => {
    expect(
      resolveWorktreeCardBoardStatus(
        { workspaceStatus: 'todo' },
        DEFAULT_WORKSPACE_STATUSES,
        'repo'
      )?.id
    ).toBe('todo')
  })

  it('hides the default status (in progress) and unset status', () => {
    expect(
      resolveWorktreeCardBoardStatus(
        { workspaceStatus: 'in-progress' },
        DEFAULT_WORKSPACE_STATUSES,
        'repo'
      )
    ).toBeNull()
    expect(resolveWorktreeCardBoardStatus({}, DEFAULT_WORKSPACE_STATUSES, 'repo')).toBeNull()
  })

  it('hides an unknown status, which the board files under the default lane', () => {
    expect(
      resolveWorktreeCardBoardStatus(
        { workspaceStatus: 'deleted-column' },
        DEFAULT_WORKSPACE_STATUSES,
        'none'
      )
    ).toBeNull()
  })

  it('hides when the sidebar is already grouped by status', () => {
    expect(
      resolveWorktreeCardBoardStatus(
        { workspaceStatus: 'in-review' },
        DEFAULT_WORKSPACE_STATUSES,
        'workspace-status'
      )
    ).toBeNull()
  })

  it('falls back to default statuses while the store is hydrating', () => {
    expect(
      resolveWorktreeCardBoardStatus({ workspaceStatus: 'completed' }, [], 'repo')?.label
    ).toBe('Done')
  })

  it('uses custom board columns', () => {
    const custom = [
      { id: 'backlog', label: 'Backlog' },
      { id: 'qa', label: 'QA', color: 'violet', icon: 'circle-dot' }
    ]
    expect(resolveWorktreeCardBoardStatus({ workspaceStatus: 'qa' }, custom, 'repo')?.label).toBe(
      'QA'
    )
    expect(
      resolveWorktreeCardBoardStatus({ workspaceStatus: 'backlog' }, custom, 'repo')
    ).toBeNull()
  })
})
