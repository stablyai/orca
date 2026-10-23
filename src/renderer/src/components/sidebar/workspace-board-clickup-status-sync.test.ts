import { describe, expect, it, vi } from 'vitest'
import { syncClickUpWorktreeStatus } from './workspace-board-clickup-status-sync'
import type { ClickUpTask } from '../../../../shared/clickup-types'

const task: ClickUpTask = {
  id: 'abc',
  workspaceId: 'team-1',
  name: 'Task',
  url: 'https://app.clickup.com/t/abc',
  status: { name: 'Open', color: '', type: 'custom', orderIndex: 0 },
  priority: null,
  assignees: [],
  tags: [],
  list: { id: 'list-1', name: 'Backlog' },
  createdAt: '',
  updatedAt: ''
}

function setup(names: string[]) {
  const deps = {
    getClickUpTask: vi.fn().mockResolvedValue(task),
    listClickUpLists: vi.fn().mockResolvedValue([
      {
        id: 'list-1',
        statuses: names.map((name) => ({ name }))
      }
    ]),
    updateClickUpTask: vi.fn().mockResolvedValue({ ok: true })
  }
  const run = () =>
    syncClickUpWorktreeStatus(
      {
        targetStatus: { id: 'done', label: 'Done' },
        worktreesById: new Map([
          ['wt', { linkedClickUpTaskId: 'abc', linkedClickUpWorkspaceId: 'team-1' }]
        ]),
        settings: { kind: 'local' },
        getLatestWorkspaceStatus: () => 'done'
      },
      'wt',
      deps
    )
  return { deps, run }
}

describe('ClickUp board status sync', () => {
  it('skips a board column without a matching List status', async () => {
    const { deps, run } = setup(['Open'])
    await expect(run()).resolves.toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'missing-workflow-state', provider: 'ClickUp', statusLabel: 'Done' }]
    })
    expect(deps.updateClickUpTask).not.toHaveBeenCalled()
  })

  it('matches case-insensitively and writes the exact List status name', async () => {
    const { deps, run } = setup(['DONE'])
    await expect(run()).resolves.toMatchObject({ updated: 1, failed: 0 })
    expect(deps.listClickUpLists).toHaveBeenCalledWith({ kind: 'local' }, 'team-1', 'list-1')
    expect(deps.updateClickUpTask).toHaveBeenCalledWith(
      { kind: 'local' },
      'abc',
      { status: 'DONE' },
      'team-1'
    )
  })

  it('skips ambiguous matches', async () => {
    const { deps, run } = setup(['DONE', 'Done'])
    await expect(run()).resolves.toMatchObject({ skipped: 1, failed: 0 })
    expect(deps.updateClickUpTask).not.toHaveBeenCalled()
  })
})
