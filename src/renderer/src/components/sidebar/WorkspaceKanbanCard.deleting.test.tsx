import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import type WorkspaceKanbanCardComponent from './WorkspaceKanbanCard'

const updateWorktreeMeta = vi.fn()
const openModal = vi.fn()
let isDeleting = false
let WorkspaceKanbanCard: typeof WorkspaceKanbanCardComponent

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {
        'repo-1::/repo/worktrees/deleting': {
          isDeleting,
          error: null,
          canForceDelete: false
        }
      },
      openModal,
      updateWorktreeMeta
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: () => null,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./WorktreeActivityStatusIndicator', () => ({
  WorktreeActivityStatusIndicator: () => null
}))

vi.mock('./WorktreeTitleInlineRename', () => ({
  WorktreeTitleInlineRename: ({ displayName }: { displayName: string }) => (
    <span>{displayName}</span>
  )
}))

vi.mock('./workspace-delete-quick-action', () => ({
  canShowWorkspaceDeleteQuickAction: () => false,
  useWorkspaceDeleteModifierPressed: () => false
}))

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/deleting',
    repoId: 'repo-1',
    path: '/repo/worktrees/deleting',
    displayName: 'Deleting card',
    branch: 'deleting',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

describe('WorkspaceKanbanCard deleting state', () => {
  beforeAll(async () => {
    WorkspaceKanbanCard = (await import('./WorkspaceKanbanCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    isDeleting = false
  })

  it('renders a visible loader on compact kanban cards while deleting', () => {
    isDeleting = true

    const markup = renderToStaticMarkup(
      <WorkspaceKanbanCard
        worktree={makeWorktree()}
        repo={undefined}
        isActive={false}
        isSelected={false}
        compact
        onActivate={vi.fn()}
        onSelectionGesture={() => false}
        onContextMenuSelect={() => []}
      />
    )

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('Deleting…')
  })
})
