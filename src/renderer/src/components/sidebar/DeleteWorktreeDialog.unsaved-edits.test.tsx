// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'

const mocks = vi.hoisted(() => {
  const modalData: Record<string, unknown> = {}
  const allWorktrees: Worktree[] = []
  const repos: Repo[] = []
  const openFiles: OpenFile[] = []
  const editorDrafts: Record<string, string> = {}
  const state = {
    activeModal: 'delete-worktree',
    modalData,
    closeModal: vi.fn(),
    removeWorktree: vi.fn(),
    clearWorktreeDeleteState: vi.fn(),
    allWorktrees,
    repos,
    worktreeLineageById: {},
    updateSettings: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    settings: null,
    sshTargetLabels: new Map<string, string>(),
    sshConnectionStates: new Map(),
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    gitStatusByWorktree: {},
    setGitStatus: vi.fn(),
    deleteStateByWorktreeId: {},
    openFiles,
    editorDrafts,
    openModal: vi.fn(),
    editorBufferIdOf: {},
    editorBufferViews: {}
  }
  return { state, preventFocus: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => mocks.state.allWorktrees,
  getWorktreeMapFromState: () => new Map(mocks.state.allWorktrees.map((w) => [w.id, w])),
  getWorktreeOnHostFromState: (_state: unknown, worktreeId: string) =>
    mocks.state.allWorktrees.find((w) => w.id === worktreeId)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    onOpenAutoFocus
  }: {
    children: ReactNode
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void
  }) => {
    onOpenAutoFocus?.({ preventDefault: mocks.preventFocus })
    return <div>{children}</div>
  },
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('./delete-worktree-flow', () => ({ runWorktreeDeletesInParallel: vi.fn() }))

vi.mock('@/components/editor/editor-model-owner', () => ({
  resolveEditorModelOwner: () => ({ environmentId: null, hostId: 'local' }),
  getEditorModelOwnerKey: () => ''
}))

import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'gray',
  addedAt: 1
}

const workspace: Worktree = {
  id: 'wt',
  instanceId: 'wt-instance',
  repoId: 'repo',
  path: '/workspaces/wt',
  head: 'abc',
  branch: 'wt',
  isBare: false,
  isMainWorktree: false,
  displayName: 'wt',
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

function dirty(id: string, filePath: string): OpenFile {
  return {
    id,
    filePath,
    relativePath: id,
    worktreeId: 'wt',
    language: 'ts',
    isDirty: true,
    mode: 'edit'
  }
}

describe('DeleteWorktreeDialog unsaved edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.modalData = {
      worktreeId: workspace.id,
      worktreeDeleteIdentities: [{ id: workspace.id, instanceId: workspace.instanceId }]
    }
    mocks.state.allWorktrees = [workspace]
    mocks.state.repos = [repo]
    mocks.state.openFiles = []
    mocks.state.editorDrafts = {}
    vi.mocked(runWorktreeDeletesInParallel).mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
  })

  it('shows no warning and focuses Delete when nothing unsaved closes', () => {
    render(<DeleteWorktreeDialog />)
    expect(screen.queryByText(/Unsaved edits/)).toBeNull()
    expect(mocks.preventFocus).toHaveBeenCalled()
  })

  it('lists the files whose edits are discarded and leaves focus off Delete', async () => {
    mocks.state.openFiles = [
      dirty('a.ts', '/workspaces/wt/a.ts'),
      dirty('b.ts', '/workspaces/wt/b.ts')
    ]
    render(<DeleteWorktreeDialog />)
    expect(
      await screen.findByText('Unsaved edits in 2 files will be discarded:')
    ).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
    expect(mocks.preventFocus).not.toHaveBeenCalled()
  })

  it('still deletes from the same dialog once the list was shown', async () => {
    mocks.state.openFiles = [dirty('a.ts', '/workspaces/wt/a.ts')]
    render(<DeleteWorktreeDialog />)
    await screen.findByText('Unsaved edits in 1 file will be discarded:')
    fireEvent.click(screen.getByRole('button', { name: /Delete Workspace/ }))
    expect(runWorktreeDeletesInParallel).toHaveBeenCalledWith([workspace], expect.anything())
  })
})
