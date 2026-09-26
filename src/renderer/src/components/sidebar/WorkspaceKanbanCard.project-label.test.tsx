import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { makeWorktree } from '../../store/slices/store-test-helpers'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import WorktreeCard from './WorktreeCard'

vi.mock('./WorktreeCard', () => ({ default: vi.fn(() => null) }))

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/Users/me/projects/customer-api',
    displayName: 'Customer API',
    badgeColor: '#737373',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
}

function renderCard(): void {
  renderToStaticMarkup(
    <WorkspaceKanbanCard
      worktree={makeWorktree({
        id: 'repo-1::/workspaces/orca-feature',
        repoId: 'repo-1',
        displayName: 'same-branch',
        path: '/workspaces/orca-feature',
        branch: 'same-branch'
      })}
      laneIndex={0}
      repo={makeRepo()}
      isActive={false}
      isSelected={false}
      onActivate={vi.fn()}
      onSelectionGesture={vi.fn(() => false)}
      onContextMenuSelect={vi.fn(() => [])}
    />
  )
}

beforeEach(() => {
  vi.mocked(WorktreeCard).mockClear()
})
describe('WorkspaceKanbanCard project label', () => {
  it('requests a visible project label from the shared card', () => {
    renderCard()

    expect(vi.mocked(WorktreeCard).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ showProjectLabel: true })
    )
  })
})
