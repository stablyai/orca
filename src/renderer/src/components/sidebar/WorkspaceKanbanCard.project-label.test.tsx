import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import WorktreeCard from './WorktreeCard'

vi.mock('./WorktreeCard', () => ({ default: vi.fn(() => null) }))

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/workspaces/orca-feature',
    repoId: 'repo-1',
    displayName: 'same-branch',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    createdAt: 0,
    isMainWorktree: false,
    path: '/workspaces/orca-feature',
    branch: 'same-branch',
    isBare: false,
    isPinned: false,
    isUnread: false
  } as Worktree
}

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
      worktree={makeWorktree()}
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
