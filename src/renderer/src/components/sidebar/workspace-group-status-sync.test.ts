import { describe, expect, it } from 'vitest'
import { buildWorkspaceGroupStatusUpdates } from './workspace-group-status-sync'

const statuses = [
  { id: 'todo', label: 'Todo' },
  { id: 'doing', label: 'Doing' }
]

describe('buildWorkspaceGroupStatusUpdates', () => {
  it('updates every member of a selected workspace group', () => {
    const updates = buildWorkspaceGroupStatusUpdates({
      worktreeIds: ['a'],
      allWorktrees: [
        { id: 'a', workspaceStatus: 'todo', workspaceGroupId: 'wg_1' },
        { id: 'b', workspaceStatus: 'todo', workspaceGroupId: 'wg_1' },
        { id: 'c', workspaceStatus: 'todo', workspaceGroupId: 'wg_2' }
      ],
      workspaceStatuses: statuses,
      targetStatus: 'doing'
    })

    expect(Array.from(updates)).toEqual([
      ['a', { workspaceStatus: 'doing' }],
      ['b', { workspaceStatus: 'doing' }]
    ])
  })

  it('does not write members already at the target status', () => {
    const updates = buildWorkspaceGroupStatusUpdates({
      worktreeIds: ['a'],
      allWorktrees: [
        { id: 'a', workspaceStatus: 'doing', workspaceGroupId: 'wg_1' },
        { id: 'b', workspaceStatus: 'todo', workspaceGroupId: 'wg_1' }
      ],
      workspaceStatuses: statuses,
      targetStatus: 'doing'
    })

    expect(Array.from(updates)).toEqual([['b', { workspaceStatus: 'doing' }]])
  })
})
