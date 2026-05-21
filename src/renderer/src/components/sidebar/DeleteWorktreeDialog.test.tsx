import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'

const mocks = vi.hoisted(() => {
  const state = {
    activeModal: 'delete-worktree',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    removeWorktree: vi.fn(),
    clearWorktreeDeleteState: vi.fn(),
    allWorktrees: vi.fn<() => Worktree[]>(() => []),
    worktreeLineageById: {} as Record<string, WorktreeLineage>,
    updateSettings: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    deleteStateByWorktreeId: {}
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('./delete-worktree-flow', () => ({
  runWorktreeDeletesInParallel: vi.fn()
}))

function makeWorktree(id: string, path: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

describe('DeleteWorktreeDialog lineage copy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'delete-worktree'
    mocks.state.modalData = {}
    mocks.state.allWorktrees.mockReturnValue([])
    mocks.state.worktreeLineageById = {}
    mocks.state.deleteStateByWorktreeId = {}
  })

  it('shows parent-only copy and a delete-all action when the workspace has children', async () => {
    const parent = makeWorktree('Parent workspace', '/workspaces/parent')
    const child = makeWorktree('Child workspace', '/workspaces/child')
    mocks.state.modalData = { worktreeId: parent.id }
    mocks.state.allWorktrees.mockReturnValue([parent, child])
    mocks.state.worktreeLineageById = {
      [child.id]: makeLineage(child, parent)
    }

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    const markup = renderToStaticMarkup(<DeleteWorktreeDialog />)

    expect(markup).toContain('Child workspaces won')
    expect(markup).toContain('1 child workspace will stay in Orca and on disk.')
    expect(markup).toContain('Child workspace')
    expect(markup).toContain('Delete All 2')
    expect(markup).toContain('Delete Parent Only')
    expect(markup).not.toContain('Don&apos;t ask again')
  })
})
