// @vitest-environment happy-dom

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  ensureHooksConfirmed: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ createWorktree: mocks.createWorktree }) }
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: mocks.ensureHooksConfirmed
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
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

vi.mock('@/components/ui/input', () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />
}))

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: { children: ReactNode; htmlFor?: string }) => (
    <label {...props}>{children}</label>
  )
}))

import { RelativeWorktreeCreateDialog } from './RelativeWorktreeCreateDialog'

const sourceWorktree = {
  id: 'repo-1::/remote/source',
  instanceId: 'source-instance',
  repoId: 'repo-1',
  path: '/remote/source',
  head: 'abc123',
  branch: 'feature/source',
  isBare: false,
  isMainWorktree: false,
  hostId: 'ssh:ssh-1',
  displayName: 'source',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
} satisfies Worktree

describe('RelativeWorktreeCreateDialog host routing', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('preserves the selected host through creation and activation', async () => {
    mocks.ensureHooksConfirmed.mockResolvedValue('run')
    mocks.createWorktree.mockResolvedValue({
      worktree: { ...sourceWorktree, id: 'repo-1::/remote/child' }
    })

    render(
      <RelativeWorktreeCreateDialog
        kind="child"
        worktree={sourceWorktree}
        parentWorkspace={`worktree:${sourceWorktree.id}`}
        onOpenChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create Child' }))

    await waitFor(() => expect(mocks.createWorktree).toHaveBeenCalled())
    const createArgs = mocks.createWorktree.mock.calls[0]
    expect(createArgs?.[25]).toMatchObject({ executionHostId: 'ssh:ssh-1' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/remote/child',
      expect.objectContaining({ executionHostId: 'ssh:ssh-1' })
    )
  })

  it('preserves a nested SSH host and its paired runtime owner', async () => {
    const nestedWorktree = {
      ...sourceWorktree,
      runtimeOwnerEnvironmentId: 'owner-runtime'
    }
    mocks.ensureHooksConfirmed.mockResolvedValue('run')
    mocks.createWorktree.mockResolvedValue({
      worktree: { ...nestedWorktree, id: 'repo-1::/remote/child' }
    })

    render(
      <RelativeWorktreeCreateDialog
        kind="child"
        worktree={nestedWorktree}
        parentWorkspace={`worktree:${nestedWorktree.id}`}
        onOpenChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create Child' }))

    await waitFor(() => expect(mocks.createWorktree).toHaveBeenCalled())
    expect(mocks.ensureHooksConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'setup',
      'ssh:ssh-1',
      'owner-runtime'
    )
    expect(mocks.createWorktree.mock.calls[0]?.[25]).toMatchObject({
      parentWorkspace: `worktree:${nestedWorktree.id}`,
      executionHostId: 'ssh:ssh-1',
      runtimeOwnerEnvironmentId: 'owner-runtime'
    })
  })
})
