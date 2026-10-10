// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useMemo, type JSX } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import type { Repo } from '../../../../shared/repo-types'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'
import {
  getDeleteWorktreeChangeCheckStates,
  getDeleteWorktreeDirtyChangeCounts,
  getDeleteWorktreeDirtyChangePreview,
  getDeleteWorktreeDirtyChangePreviews
} from './delete-worktree-dirty-change-counts'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

const state = vi.hoisted(() => ({
  repos: [],
  settings: null,
  activeWorktreeId: null,
  activeWorkspaceExecutionHostId: null,
  gitStatusByWorktree: {}
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/runtime/runtime-git-client', () => ({ getRuntimeGitStatus: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => null
}))

const repoMap = new Map<string, Repo>()

function target(id: string, hostId: Worktree['hostId'] = 'local'): Worktree {
  return {
    id,
    hostId,
    repoId: 'repo',
    path: `/disposable/${id}`,
    displayName: id,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function Preview({ worktree }: { worktree: Worktree }): JSX.Element {
  const targets = useMemo(() => [worktree], [worktree])
  const status = useDeleteWorktreeStatusHydration({
    isOpen: true,
    deleteTargets: targets,
    visibleTargets: targets,
    repoMap
  })
  const input = {
    deleteTargets: targets,
    gitStatusByWorktree: state.gitStatusByWorktree,
    gitStatusByWorktreeIdentity: status,
    repoMap,
    deleteStateByWorktreeId: {
      [worktree.id]: {
        isDeleting: false,
        error: null,
        canForceDelete: true,
        forceDeleteReason: 'dirty' as const,
        executionHostId: worktree.hostId
      }
    }
  }
  return (
    <DeleteWorktreeTargetPreview
      isBatchDelete={false}
      worktree={worktree}
      worktrees={targets}
      collisionWorktrees={targets}
      hostLabelById={new Map()}
      deleteStateByWorktreeId={input.deleteStateByWorktreeId}
      changeCheckStatesByWorktreeId={getDeleteWorktreeChangeCheckStates(input)}
      dirtyChangeCountsByWorktreeId={getDeleteWorktreeDirtyChangeCounts(input)}
      dirtyChangePreviewsByWorktreeId={getDeleteWorktreeDirtyChangePreviews(input)}
    />
  )
}

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('loaded deletion disclosure and existing hydration', () => {
  it('shows pending and failed detail checks alongside a known dirty warning', async () => {
    let failRead: (error: Error) => void = () => {
      throw new Error('Status read has not started')
    }
    vi.mocked(getRuntimeGitStatus).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRead = reject
        })
    )
    render(<Preview worktree={target('known-dirty')} />)
    expect(screen.getByText('Uncommitted or untracked changes')).toBeVisible()
    expect(screen.getByText('· Checking…')).toBeVisible()
    await act(async () => {
      failRead(new Error('Details unavailable'))
    })
    expect(screen.getByText('Uncommitted or untracked changes')).toBeVisible()
    expect(screen.getByText('· Details unavailable')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/No uncommitted|0 changes/)).not.toBeInTheDocument()
  })

  it('expands and collapses a hydrated snapshot without requesting status again', async () => {
    vi.mocked(getRuntimeGitStatus).mockResolvedValue({
      entries: [
        { path: 'staged.ts', status: 'added', area: 'staged' },
        { path: 'unstaged.ts', status: 'modified', area: 'unstaged' },
        { path: 'scratch.txt', status: 'untracked', area: 'untracked' }
      ],
      conflictOperation: 'unknown'
    })
    const view = render(<Preview worktree={target('feature')} />)
    const trigger = await screen.findByRole('button', {
      name: '3 uncommitted or untracked changes: Show loaded paths'
    })
    expect(getRuntimeGitStatus).toHaveBeenCalledOnce()
    fireEvent.click(trigger)
    expect(screen.getByText('staged.ts')).toBeVisible()
    expect(screen.getByText('unstaged.ts')).toBeVisible()
    expect(screen.getByText('scratch.txt')).toBeVisible()
    fireEvent.click(trigger)
    expect(screen.queryByText('staged.ts')).not.toBeInTheDocument()
    expect(getRuntimeGitStatus).toHaveBeenCalledOnce()
    const signal = vi.mocked(getRuntimeGitStatus).mock.calls[0]?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('ignores an old generation and preserves the dirty warning if the next read fails', async () => {
    let finishFirst: (result: GitStatusResult) => void = () => {
      throw new Error('First read has not started')
    }
    vi.mocked(getRuntimeGitStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve
          })
      )
      .mockRejectedValueOnce(new Error('Status unavailable'))
    const first = target('same')
    const second = target('same', 'runtime:fixture')
    const view = render(<Preview worktree={first} />)
    const oldSignal = vi.mocked(getRuntimeGitStatus).mock.calls[0]?.[1]?.signal
    view.rerender(<Preview worktree={second} />)
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => {
      finishFirst({
        entries: [{ path: 'old-host.ts', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown'
      })
    })
    await waitFor(() => expect(getRuntimeGitStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Uncommitted or untracked changes')).toBeVisible()
    expect(screen.getByText('· Details unavailable')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('old-host.ts')).not.toBeInTheDocument()
    expect(screen.queryByText(/No files|clean|0 changes/)).not.toBeInTheDocument()
  })

  it('exposes only the four existing visible lineage children, retaining conflict context', () => {
    const descendants = Array.from({ length: 5 }, (_, index) => target(`child-${index}`))
    const preview = getDeleteWorktreeDirtyChangePreview([
      {
        path: 'conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'unresolved',
        conflictKind: 'both_modified'
      }
    ])
    render(
      <DeleteWorktreeLineageNotice
        descendants={descendants}
        dirtyChangeCountsByWorktreeId={
          new Map(descendants.map((child) => [getWorktreeHostIdentity(child), 1]))
        }
        dirtyChangePreviewsByWorktreeId={
          new Map(descendants.map((child) => [getWorktreeHostIdentity(child), preview]))
        }
      />
    )
    expect(screen.getAllByRole('button')).toHaveLength(4)
    expect(screen.queryByText('child-4')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(screen.getByText('Unresolved conflict')).toBeVisible()
    expect(screen.getByText('conflict.ts')).toBeVisible()
  })
})
