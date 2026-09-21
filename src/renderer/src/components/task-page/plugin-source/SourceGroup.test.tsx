// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { ContributedPluginTaskSource } from '@/store/slices/plugin-task-sources-slice-contract'
import { TaskPagePluginSourceGroup } from './SourceGroup'

afterEach(cleanup)

const BOARDS: ContributedPluginTaskSource = {
  pluginKey: 'orca-samples.issues',
  sourceId: 'boards',
  title: 'Boards'
}
const SPRINTS: ContributedPluginTaskSource = {
  pluginKey: 'orca-samples.issues',
  sourceId: 'sprints',
  title: 'Sprints'
}

describe('TaskPage contributed source group', () => {
  it('renders nothing when no plugin contributes a source', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup sources={[]} selected={null} onSelect={vi.fn()} />
      </TooltipProvider>
    )

    expect(container.querySelector('[data-plugin-task-source]')).toBeNull()
  })

  it('renders one button per contributed source in contribution order', () => {
    render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup sources={[BOARDS, SPRINTS]} selected={null} onSelect={vi.fn()} />
      </TooltipProvider>
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('data-plugin-task-source'))).toEqual([
      'boards',
      'sprints'
    ])
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the selection for the clicked source', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup
          sources={[BOARDS, SPRINTS]}
          selected={null}
          onSelect={onSelect}
        />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Sprints' }))
    expect(onSelect).toHaveBeenCalledWith({
      pluginKey: 'orca-samples.issues',
      sourceId: 'sprints'
    })
  })

  it('marks only the selected source as pressed', () => {
    render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup
          sources={[BOARDS, SPRINTS]}
          selected={{ pluginKey: 'orca-samples.issues', sourceId: 'sprints' }}
          onSelect={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: 'Boards' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Sprints' })).toHaveAttribute('aria-pressed', 'true')
  })
})
