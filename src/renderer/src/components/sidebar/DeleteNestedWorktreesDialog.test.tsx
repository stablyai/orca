// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteNestedWorktreesDialog } from './DeleteNestedWorktreesDialog'
import { toast } from 'sonner'
import type { Worktree } from '../../../../shared/worktree/types'
import { createWorktreeDeleteAdmission } from './worktree-delete-request'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => ({
  rows: Array<Worktree>(),
  preview: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn()
}))
vi.mock('@/store', () => {
  const state = {
    activeWorktreeId: 'repo::/workspaces/parent',
    removeWorktree: mocks.remove,
    markWorktreesDeleting: vi.fn(),
    clearWorktreeDeleteState: vi.fn(),
    fetchAllWorktrees: mocks.refresh,
    get worktreesByRepo() {
      return { repo: mocks.rows }
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    openFiles: [],
    editorDrafts: {}
  }
  return {
    useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})
vi.mock('@/store/selectors', () => ({
  getWorktreeOnHostFromState: () => null,
  getAllWorktreesFromState: () => []
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const target = { id: 'repo::/workspaces/parent', executionHostId: 'local' as const }
const plan = [
  {
    path: '/workspaces/parent/.tmp/child',
    branch: 'child',
    head: 'child-head',
    isMainWorktree: false,
    isBare: false
  },
  {
    path: '/workspaces/parent',
    branch: 'parent',
    head: 'parent-head',
    isMainWorktree: false,
    isBare: false
  }
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows = []
  mocks.preview.mockResolvedValue(plan)
  mocks.remove.mockResolvedValue({ ok: true })
  mocks.refresh.mockResolvedValue(undefined)
  Object.assign(window, { api: { worktrees: { previewNestedRemoval: mocks.preview } } })
})
afterEach(cleanup)

async function review(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Delete with nested worktrees…' }))
  await screen.findByText(plan[0].path)
}

describe('nested deletion confirmation', () => {
  it('lists hidden Git registrations and warns about lost changes before any deletion', async () => {
    render(
      <DeleteNestedWorktreesDialog target={target} worktreeName="parent" dismissToast={vi.fn()} />
    )
    await review()
    expect(mocks.preview).toHaveBeenCalledWith({ worktreeId: target.id, hostId: 'local' })
    expect(screen.getByRole('dialog')).toHaveTextContent('including uncommitted changes')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(mocks.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('sends only the reviewed set to the confirmed host and refreshes after success', async () => {
    const dismissToast = vi.fn()
    const onDeleted = vi.fn()
    render(
      <DeleteNestedWorktreesDialog
        target={target}
        worktreeName="parent"
        dismissToast={dismissToast}
        onDeleted={onDeleted}
      />
    )
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all listed worktrees' }))
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(mocks.remove).toHaveBeenCalledWith(target, true, {
      approvedNestedWorktrees: plan,
      assertBeforeDispatch: undefined,
      confirmedDiscards: expect.any(Map)
    })
    expect(dismissToast).toHaveBeenCalledOnce()
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('closes immediately while deletion is pending and prevents a second submission', async () => {
    let finish: (value: { ok: boolean }) => void = () => {}
    mocks.remove.mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        finish = resolve
      })
    )
    const dismissToast = vi.fn()
    const onDeleted = vi.fn()
    render(
      <DeleteNestedWorktreesDialog
        target={target}
        worktreeName="parent"
        dismissToast={dismissToast}
        onDeleted={onDeleted}
      />
    )
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all listed worktrees' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
    await act(async () => {
      finish({ ok: true })
    })
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(onDeleted).toHaveBeenCalledOnce()
    expect(dismissToast).toHaveBeenCalledOnce()
  })

  it.each(['refused', 'rejected'])(
    'reports a %s deletion in a toast and requires a fresh review',
    async (outcome) => {
      if (outcome === 'refused') {
        mocks.remove.mockResolvedValue({ ok: false, error: 'Child archive hook failed' })
      } else {
        mocks.remove.mockRejectedValue(new Error('Child archive hook failed'))
      }
      render(
        <DeleteNestedWorktreesDialog target={target} worktreeName="parent" dismissToast={vi.fn()} />
      )
      await review()
      fireEvent.click(screen.getByRole('button', { name: 'Delete all listed worktrees' }))
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to delete workspace', {
          description: 'Child archive hook failed'
        })
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(mocks.refresh).toHaveBeenCalledOnce()
      expect(
        screen.queryByRole('button', { name: 'Delete all listed worktrees' })
      ).not.toBeInTheDocument()
      await review()
      await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(2))
    }
  )

  it('ignores a late preview after cancellation', async () => {
    let finish: (value: typeof plan) => void = () => {}
    mocks.preview.mockReturnValue(
      new Promise<typeof plan>((resolve) => {
        finish = resolve
      })
    )
    render(
      <DeleteNestedWorktreesDialog target={target} worktreeName="parent" dismissToast={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete with nested worktrees…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      finish(plan)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})

it.each(['preview', 'approval'] as const)(
  'retains selected owner through nested %s',
  async (seam) => {
    const selected = makeWorktree({
      id: target.id,
      repoId: 'repo',
      path: '/workspaces/parent',
      hostId: 'local',
      instanceId: 'copy'
    })
    mocks.rows = [selected]
    const admission = createWorktreeDeleteAdmission(selected)
    const pending = Promise.withResolvers<typeof plan>()
    if (seam === 'preview') {
      mocks.preview.mockReturnValueOnce(pending.promise)
    }
    render(
      <DeleteNestedWorktreesDialog
        target={target}
        worktreeName="parent"
        dismissToast={vi.fn()}
        assertBeforeDispatch={admission}
      />
    )
    if (seam === 'preview') {
      fireEvent.click(screen.getByRole('button', { name: 'Delete with nested worktrees…' }))
      await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
    } else {
      await review()
    }
    mocks.rows = [{ ...selected, runtimeOwnerEnvironmentId: 'B' }]
    if (seam === 'preview') {
      await act(async () => {
        pending.resolve(plan)
      })
      expect(await screen.findByRole('alert')).toHaveTextContent('selected workspace changed')
      expect(
        screen.queryByRole('button', { name: 'Delete all listed worktrees' })
      ).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Review again' })).toBeEnabled()
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Delete all listed worktrees' }))
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to delete workspace', {
          description: 'The selected workspace changed. Select it again.'
        })
      )
    }
    expect(mocks.remove).not.toHaveBeenCalled()
  }
)
