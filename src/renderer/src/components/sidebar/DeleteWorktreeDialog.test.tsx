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
    settings: null,
    gitStatusByWorktree: {} as Record<string, { path: string; status: 'modified' }[]>,
    setGitStatus: vi.fn(),
    deleteStateByWorktreeId: {} as Record<
      string,
      {
        isDeleting: boolean
        error: string | null
        canForceDelete: boolean
        forceDeleteReason: 'dirty' | 'orphan-directory' | 'missing-registration' | null
        lockReason?: string | null
      }
    >
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

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
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

vi.mock('./active-worktree-focus-after-delete', () => ({
  prepareActiveWorktreeFocusAfterDelete: () => vi.fn()
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

function buttonText(props: Record<string, unknown>): string {
  return renderToStaticMarkup(<>{props.children as ReactNode}</>)
}

function visibleMarkupText(markup: string): string {
  return markup.replace(/<[^>]*>/g, '')
}

describe('DeleteWorktreeDialog lineage copy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'delete-worktree'
    mocks.state.modalData = {}
    mocks.state.allWorktrees.mockReturnValue([])
    mocks.state.repos = []
    mocks.state.worktreeLineageById = {}
    mocks.state.gitStatusByWorktree = {}
    mocks.state.deleteStateByWorktreeId = {}
    mocks.buttonProps = []
    vi.mocked(runWorktreeDeletesInParallel).mockResolvedValue([])
  })

  it('shows child-delete copy and only a delete-all action when the workspace has children', async () => {
    const parent = makeWorktree('Parent workspace', '/workspaces/parent')
    const child = makeWorktree('Child workspace', '/workspaces/child')
    mocks.state.modalData = { worktreeId: parent.id }
    mocks.state.allWorktrees.mockReturnValue([parent, child])
    mocks.state.worktreeLineageById = {
      [child.id]: makeLineage(child, parent)
    }

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    const markup = renderToStaticMarkup(<DeleteWorktreeDialog />)

    expect(markup).toContain('Child workspaces will be deleted')
    expect(markup).toContain('Deleting this workspace also deletes 1 child workspace.')
    expect(markup).toContain('Child workspace')
    expect(markup).toContain('from git and delete their workspace folders.')
    expect(markup).not.toContain('from git and delete its workspace folder.')
    expect(markup).toContain('Delete 2 Workspaces')
    expect(markup).not.toContain('Delete Parent Only')
    expect(markup).not.toContain('Don&apos;t ask again')

    const destructiveButton = mocks.buttonProps.find((props) => props.variant === 'destructive')
    const parentOnlyButton = mocks.buttonProps.find((props) =>
      buttonText(props).includes('Delete Parent Only')
    )

    expect(destructiveButton ? buttonText(destructiveButton) : '').toContain('Delete 2 Workspaces')
    expect(parentOnlyButton).toBeUndefined()

    const deleteAllButton = destructiveButton as { onClick?: () => void } | undefined
    deleteAllButton?.onClick?.()

    expect(runWorktreeDeletesInParallel).toHaveBeenCalledWith([child, parent], {
      force: true,
      onForceDeleted: expect.any(Function)
    })
  })

  it('keeps long child workspace paths constrained inside the lineage notice', async () => {
    const child = makeWorktree(
      'docs-file-upload-discovery-with-a-very-long-name',
      '/Users/jinjingliang/Documents/projects/agent-slack/docs-file-upload-discovery-with-a-very-long-path-segment'
    )
    const { DeleteWorktreeLineageNotice } = await import('./DeleteWorktreeLineageNotice')

    const markup = renderToStaticMarkup(
      <DeleteWorktreeLineageNotice
        descendants={[child]}
        dirtyChangeCountsByWorktreeId={new Map()}
      />
    )

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
    expect(markup).not.toContain('including uncommitted or untracked files')
  })

  it('keeps a space between remove copy and the workspace name', async () => {
    const workspace = makeWorktree('Hide working dot', '/workspaces/hide-working-dot')
    mocks.state.modalData = { worktreeId: workspace.id }
    mocks.state.allWorktrees.mockReturnValue([workspace])

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    const markup = renderToStaticMarkup(<DeleteWorktreeDialog />)

    expect(visibleMarkupText(markup)).toContain(
      'Remove Hide working dot from git and delete its workspace folder.'
    )
    expect(markup).not.toContain('RemoveHide working dot')
  })

  it('shows an inline warning when the workspace has uncommitted or untracked changes', async () => {
    const workspace = makeWorktree('Feature workspace', '/workspaces/feature')
    mocks.state.modalData = { worktreeId: workspace.id }
    mocks.state.allWorktrees.mockReturnValue([workspace])
    mocks.state.gitStatusByWorktree = {
      [workspace.id]: [
        { path: 'src/file.ts', status: 'modified' },
        { path: 'notes.md', status: 'modified' }
      ]
    }

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    const markup = renderToStaticMarkup(<DeleteWorktreeDialog />)

    expect(markup).toContain('2 uncommitted or untracked changes')
    expect(markup).toContain('Deleting this workspace permanently removes these changes from disk.')
    expect(markup).not.toContain('Also delete local branch')
  })

  it('shows locked and known dirty details without offering a lock override', async () => {
    const workspace = makeWorktree('Locked workspace', '/workspaces/locked')
    mocks.state.modalData = { worktreeId: workspace.id }
    mocks.state.allWorktrees.mockReturnValue([workspace])
    mocks.state.gitStatusByWorktree = {
      [workspace.id]: [{ path: 'src/file.ts', status: 'modified' }]
    }
    mocks.state.deleteStateByWorktreeId = {
      [workspace.id]: {
        isDeleting: false,
        error: 'Worktree is locked by Git. Lock reason: active agent session.',
        canForceDelete: false,
        forceDeleteReason: null,
        lockReason: 'active agent session'
      }
    }

    const { default: DeleteWorktreeDialog } = await import('./DeleteWorktreeDialog')
    const markup = renderToStaticMarkup(<DeleteWorktreeDialog />)

    expect(markup).toContain('Worktree is locked by Git. Lock reason: active agent session.')
    expect(markup).not.toContain('Force Delete')
    expect(markup).toContain('1 uncommitted or untracked change')
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
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
      force: true,
      onForceDeleted: expect.any(Function)
    })
    const options = vi.mocked(runWorktreeDeletesInParallel).mock.calls[0]?.[1] as
      | { onForceDeleted?: (worktreeId: string) => void }
      | undefined
    options?.onForceDeleted?.(workspace.id)

    expect(onDeleted).toHaveBeenCalledWith([workspace.id])
  })
})
