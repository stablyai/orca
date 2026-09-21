// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { TaskPagePluginSourceList } from './List'

afterEach(cleanup)

function taskItem(overrides: Partial<PluginTaskItem> = {}): PluginTaskItem {
  return {
    id: 'item-1',
    key: 'BOARD-7',
    title: 'Ship the source bar',
    state: { name: 'In Progress', category: 'in-progress' },
    assignee: { id: 'u1', displayName: 'Ada Lovelace', avatarUrl: null },
    url: null,
    updatedAt: null,
    scopeId: null,
    ...overrides
  }
}

describe('TaskPage contributed source list', () => {
  it('renders key, title, state name and assignee for each item', () => {
    render(
      <TaskPagePluginSourceList
        title="Boards"
        items={[taskItem()]}
        loading={false}
        error={null}
        onUseItem={vi.fn()}
      />
    )

    expect(screen.getByText('BOARD-7')).toBeInTheDocument()
    expect(screen.getByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('shows the loading treatment before any item arrives', () => {
    const { container } = render(
      <TaskPagePluginSourceList
        title="Boards"
        items={[]}
        loading={true}
        error={null}
        onUseItem={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })

  it('renders the error message instead of an empty-list state', () => {
    render(
      <TaskPagePluginSourceList
        title="Boards"
        items={[]}
        loading={false}
        error={{ code: 'unauthorized', message: 'Board token expired.' }}
        onUseItem={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Board token expired.')
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })

  it('reports an empty board only when the source succeeded', () => {
    render(
      <TaskPagePluginSourceList
        title="Boards"
        items={[]}
        loading={false}
        error={null}
        onUseItem={vi.fn()}
      />
    )

    expect(screen.getByText('No tasks found')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('seeds a task with the clicked item', async () => {
    const user = userEvent.setup()
    const onUseItem = vi.fn()
    const item = taskItem({ id: 'item-2', key: 'BOARD-9' })
    render(
      <TaskPagePluginSourceList
        title="Boards"
        items={[taskItem(), item]}
        loading={false}
        error={null}
        onUseItem={onUseItem}
      />
    )

    await user.click(screen.getByRole('button', { name: /BOARD-9/ }))
    expect(onUseItem).toHaveBeenCalledWith(item)
  })
})
