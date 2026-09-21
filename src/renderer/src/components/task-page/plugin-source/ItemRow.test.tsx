// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { getAssigneeAvatarTone, NEUTRAL_AVATAR_TONE } from '@/lib/assignee-avatar-tone'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { TaskPagePluginSourceItemRow } from './ItemRow'

afterEach(cleanup)

function taskItem(overrides: Partial<PluginTaskItem> = {}): PluginTaskItem {
  return {
    id: 'item-1',
    key: 'BOARD-7',
    title: 'Ship the source bar',
    state: { name: 'In Progress', category: 'in-progress' },
    assignee: { id: 'u1', displayName: 'David Mugisha', avatarUrl: null },
    url: null,
    updatedAt: null,
    scopeId: null,
    ...overrides
  }
}

function renderRow(item: PluginTaskItem): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskPagePluginSourceItemRow item={item} onOpenItem={vi.fn()} onUseItem={vi.fn()} />
    </TooltipProvider>
  )
}

describe('TaskPage contributed source item row assignee avatar', () => {
  it('renders initials when the assignee has no avatarUrl', () => {
    renderRow(taskItem({ assignee: { id: 'u1', displayName: 'David Mugisha', avatarUrl: null } }))

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('DM')).toBeInTheDocument()
  })

  it('falls back to initials when the avatar image fails to load', () => {
    renderRow(
      taskItem({
        assignee: {
          id: 'u1',
          displayName: 'David Mugisha',
          avatarUrl: 'https://dev.azure.com/org/_apis/GraphProfile/MemberAvatars/aad.abc'
        }
      })
    )

    const image = screen.getByRole('img', { name: 'David Mugisha' })
    fireEvent.error(image)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('DM')).toBeInTheDocument()
  })

  it('renders the first letter for a single-word name', () => {
    renderRow(taskItem({ assignee: { id: 'u1', displayName: 'Cher', avatarUrl: null } }))

    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('renders a dash for an empty or whitespace-only name without crashing', () => {
    renderRow(taskItem({ assignee: { id: 'u1', displayName: '   ', avatarUrl: null } }))

    expect(screen.getByText('-')).toBeInTheDocument()
  })

  it('renders "Unassigned" and a dash badge when there is no assignee', () => {
    renderRow(taskItem({ assignee: null }))

    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0)
    expect(screen.getByText('-')).toBeInTheDocument()
  })

  it('tints the initials badge with the assignee tone', () => {
    renderRow(taskItem({ assignee: { id: 'u1', displayName: 'David Mugisha', avatarUrl: null } }))

    expect(screen.getByText('DM').className).toContain(
      getAssigneeAvatarTone({ id: 'u1', displayName: 'David Mugisha' })
    )
  })

  it('gives two assignees with different ids different badge tones', () => {
    renderRow(taskItem({ assignee: { id: 'u1', displayName: 'Amelia Kato', avatarUrl: null } }))
    renderRow(
      taskItem({
        id: 'item-2',
        assignee: { id: 'u2', displayName: 'Musa Rahman', avatarUrl: null }
      })
    )

    expect(screen.getByText('AK').className).not.toBe(screen.getByText('MR').className)
  })

  it('leaves the unassigned badge on the neutral tone', () => {
    renderRow(taskItem({ assignee: null }))

    expect(screen.getByText('-').className).toContain(NEUTRAL_AVATAR_TONE)
  })
})
