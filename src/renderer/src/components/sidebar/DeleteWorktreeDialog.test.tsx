import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeLineage } from '../../../../shared/types'

const mocks = vi.hoisted(() => {
  const state = {
    activeModal: 'delete-worktree',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    removeWorktree: vi.fn(),
    clearWorktreeDeleteState: vi.fn(),
    allWorktrees: vi.fn<() => Worktree[]>(() => []),
    repos: [] as Repo[],
    worktreeLineageById: {} as Record<string, WorktreeLineage>,
    updateSettings: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    deleteStateByWorktreeId: {}
  }
  return { state, buttonProps: [] as Record<string, unknown>[] }
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
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => {
    mocks.buttonProps.push({ ...props, children })
    return <button {...props}>{children}</button>
  }
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

import { runWorktreeDeletesInParallel } from './delete-worktree-flow'

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
    mocks.state.repos = []
    mocks.state.worktreeLineageById = {}
    mocks.state.deleteStateByWorktreeId = {}
    mocks.buttonProps = []
    vi.mocked(runWorktreeDeletesInParallel).mockResolvedValue([])
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

  it('keeps long child workspace paths constrained inside the lineage notice', async () => {
    const child = makeWorktree(
      'docs-file-upload-discovery-with-a-very-long-name',
      '/Users/jinjingliang/Documents/projects/agent-slack/docs-file-upload-discovery-with-a-very-long-path-segment'
    )
    const { DeleteWorktreeLineageNotice } = await import('./DeleteWorktreeLineageNotice')

    const markup = renderToStaticMarkup(<DeleteWorktreeLineageNotice descendants={[child]} />)

    expect(markup).toContain('min-w-0 max-w-full overflow-hidden rounded-md')
    expect(markup).toContain('mt-2 min-w-0 max-w-full space-y-1 overflow-hidden')
    expect(markup).toContain('min-w-0 overflow-hidden')
    expect(markup).toContain('truncate text-muted-foreground')
  })

  it('uses non-destructive disk copy for folder workspace deletes', async () => {
    const workspace = {
      ...makeWorktree('Folder workspace', '/projects/folder'),
      repoId: 'folder-repo'
    }
    mocks.state.modalData = { worktreeId: workspace.id }
    mocks.state.allWorktrees.mockReturnValue([workspace])
    mocks.state.repos = [
      {
        id: 'folder-repo',
        path: '/projects/folder',
        displayName: 'Folder',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder'
      }
    ]

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    const markup = renderToStaticMarkup(<DeleteWorktreeDialog />)

    expect(markup).toContain('from Orca. The project folder on disk will not be deleted.')
    expect(markup).not.toContain('from git and delete its workspace folder.')
  })

  it('notifies the dialog caller after a toast force delete succeeds', async () => {
    const workspace = makeWorktree('Workspace', '/workspaces/workspace')
    const onDeleted = vi.fn()
    mocks.state.modalData = { worktreeId: workspace.id, onDeleted }
    mocks.state.allWorktrees.mockReturnValue([workspace])

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    renderToStaticMarkup(<DeleteWorktreeDialog />)

    const deleteButton = mocks.buttonProps.find((props) => props.variant === 'destructive') as
      | { onClick?: (event: never) => void }
      | undefined
    expect(deleteButton).toBeDefined()
    deleteButton?.onClick?.(undefined as never)

    expect(runWorktreeDeletesInParallel).toHaveBeenCalledWith([workspace], {
      onForceDeleted: expect.any(Function)
    })
    const options = vi.mocked(runWorktreeDeletesInParallel).mock.calls[0]?.[1] as
      | { onForceDeleted?: (worktreeId: string) => void }
      | undefined
    options?.onForceDeleted?.(workspace.id)

    expect(onDeleted).toHaveBeenCalledWith([workspace.id])
  })
})
