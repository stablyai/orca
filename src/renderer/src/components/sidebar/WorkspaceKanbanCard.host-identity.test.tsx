// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '../../store/slices/store-test-helpers'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./WorktreeCard', () => ({
  default: ({
    onSelectionGesture
  }: {
    onSelectionGesture: (event: React.MouseEvent<HTMLElement>) => void
  }) => (
    <button type="button" onClick={onSelectionGesture}>
      Select
    </button>
  )
}))

afterEach(cleanup)

describe('WorkspaceKanbanCard host identity', () => {
  it('keeps the DOM and selection gesture scoped to one host', () => {
    const onSelectionGesture = vi.fn(() => false)
    const { container } = render(
      <WorkspaceKanbanCard
        worktree={makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' })}
        laneIndex={0}
        repo={undefined}
        isActive={false}
        isSelected={false}
        onActivate={() => {}}
        onSelectionGesture={onSelectionGesture}
        onContextMenuSelect={() => []}
      />
    )

    const card = container.querySelector<HTMLElement>('[data-workspace-board-card-id]')
    expect(card?.dataset.workspaceBoardCardId).toBe('ssh:host-b|shared')
    expect(card?.dataset.workspaceBoardWorktreeId).toBe('shared')
    fireEvent.click(container.querySelector('button')!)
    expect(onSelectionGesture).toHaveBeenCalledWith(expect.anything(), 'ssh:host-b|shared')
  })
})
