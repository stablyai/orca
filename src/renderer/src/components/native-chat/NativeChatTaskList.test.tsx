// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatTask } from '../../../../shared/native-chat-task-list'
import { NativeChatTaskList } from './NativeChatTaskList'

afterEach(() => cleanup())

describe('NativeChatTaskList', () => {
  it('prioritizes active work and caps the visible list like Claude', () => {
    const tasks: NativeChatTask[] = [
      ...Array.from({ length: 7 }, (_unused, index) => ({
        id: String(index),
        subject: `Completed phase ${index}`,
        status: 'completed' as const
      })),
      {
        id: 'active',
        subject: 'Monitor the PR',
        activeForm: 'Monitoring the PR until merge',
        status: 'in_progress'
      }
    ]

    render(<NativeChatTaskList tasks={tasks} />)

    expect(
      screen.getByRole('region', { name: '8 tasks (7 done, 1 in progress, 0 open)' })
    ).toBeInTheDocument()
    expect(screen.getByText('Monitoring the PR until merge')).toBeInTheDocument()
    expect(screen.queryByText('Monitor the PR')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getByText('+3 completed')).toBeInTheDocument()
  })

  it('shows pending tasks ahead of completed history', () => {
    render(
      <NativeChatTaskList
        tasks={[
          { id: 'done', subject: 'Finished', status: 'completed' },
          { id: 'next', subject: 'Next', status: 'pending' }
        ]}
      />
    )

    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['Next', 'Finished'])
  })
})
