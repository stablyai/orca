// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ClickUpTask } from '../../../shared/clickup-types'
import { ClickUpTaskListTable } from './clickup-task-list-table'

const task: ClickUpTask = {
  id: '86abc123',
  customId: 'CU-12',
  workspaceId: 'team-1',
  name: 'Fix export',
  url: 'https://app.clickup.com/t/86abc123',
  status: { name: 'Open', color: '', type: 'custom', orderIndex: 0 },
  priority: null,
  assignees: [],
  tags: [],
  list: { id: 'list-1', name: 'Backlog' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z'
}

describe('ClickUpTaskListTable', () => {
  it('leaves keyboard activation of a row action with that action', () => {
    const onOpenTask = vi.fn()
    render(
      <ClickUpTaskListTable
        tasks={[task]}
        loading={false}
        error={null}
        onOpenTask={onOpenTask}
        onStartWorkspace={vi.fn()}
      />
    )

    const eventAllowed = fireEvent.keyDown(
      screen.getByRole('button', { name: 'Start workspace' }),
      { key: 'Enter' }
    )

    expect(eventAllowed).toBe(true)
    expect(onOpenTask).not.toHaveBeenCalled()
  })
})
