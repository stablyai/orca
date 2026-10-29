// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'

const mocks = vi.hoisted(() => {
  const allWorktrees: Worktree[] = []
  const modalData: Record<string, unknown> = {}
  const state = {
    modalData,
    closeModal: vi.fn(),
    removeWorktree: vi.fn(),
    clearWorktreeDeleteState: vi.fn(),
    allWorktrees,
    sshTargetLabels: new Map<string, string>(),
    removedSshTargetLabels: new Map<string, string>(),
    gitStatusByWorktree: {},
    deleteStateByWorktreeId: {}
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/store/selectors', () => ({
  getWorktreeOnHostFromState: (_state: unknown, worktreeId: string, hostId?: string) =>
    mocks.state.allWorktrees.find(
      (w) => w.id === worktreeId && (hostId === undefined || w.hostId === hostId)
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
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('./RemovalUnsavedFilesNotice', () => ({ RemovalUnsavedFilesNotice: () => null }))
vi.mock('./removal-unsaved-files', () => ({ blockRemovalForUnsavedFiles: () => false }))
vi.mock('@/store/slices/worktrees/teardown/removed-workspace-unsaved-files', () => ({
  confirmUnsavedDiscard: () => new Map()
}))

import ForgetSshWorkspaceDialog from './ForgetSshWorkspaceDialog'

const hostId = 'ssh:box' as const

function sshWorkspace(instanceId: string): Worktree {
  return {
    id: 'repo::/srv/wt',
    instanceId,
    hostId,
    repoId: 'repo',
    path: '/srv/wt',
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
}

describe('ForgetSshWorkspaceDialog', () => {
  beforeEach(() => {
    mocks.state.allWorktrees.splice(0, mocks.state.allWorktrees.length, sshWorkspace('instance-A'))
    mocks.state.modalData = {
      worktreeId: 'repo::/srv/wt',
      worktreeDeleteIdentities: [{ id: 'repo::/srv/wt', instanceId: 'instance-A', hostId }],
      displayName: 'wt',
      resolution: { kind: 'saved', targetId: 'box' }
    }
    mocks.state.removeWorktree.mockReset().mockResolvedValue({ ok: true })
    mocks.state.closeModal.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('forgets a saved host’s workspace on its SSH host without a remote delete', async () => {
    render(<ForgetSshWorkspaceDialog />)

    fireEvent.click(screen.getByText('Remove from Orca'))

    await waitFor(() => expect(mocks.state.closeModal).toHaveBeenCalled())
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith(
      { id: 'repo::/srv/wt', executionHostId: hostId },
      false,
      expect.objectContaining({ mode: 'forget-local' })
    )
  })
})
