// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'
import WorkspaceStatusPicker from './WorkspaceStatusPicker'

const mocks = vi.hoisted(() => {
  const worktree: { value: Record<string, unknown> | null } = { value: null }
  const state: Record<string, unknown> = {}
  return {
    closeModal: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    toastError: vi.fn(),
    captureReturnFocus: vi.fn(),
    worktree,
    state
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (value: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/store/selectors', () => ({ useActiveWorktree: () => mocks.worktree.value }))
vi.mock('@/hooks/useModalReturnFocus', () => ({
  useModalReturnFocus: () => ({
    captureReturnFocus: mocks.captureReturnFocus,
    skipReturnFocus: () => {}
  })
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

function openPicker(worktree: Record<string, unknown>, extraState: Record<string, unknown> = {}) {
  mocks.worktree.value = { id: 'repo::/wt', ...worktree }
  for (const key of Object.keys(mocks.state)) {
    delete mocks.state[key]
  }
  Object.assign(mocks.state, {
    activeModal: 'workspace-status-picker',
    closeModal: mocks.closeModal,
    updateWorktreeMeta: mocks.updateWorktreeMeta,
    workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
    ...extraState
  })
}

const optionLabels = () => screen.getAllByRole('option').map((option) => option.textContent)
const selectedLabel = () =>
  screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')
    ?.textContent

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateWorktreeMeta.mockResolvedValue({ ok: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe('workspace status picker', () => {
  it('lists every status in board order and starts on the current one', () => {
    openPicker({ workspaceStatus: 'in-review' })
    render(<WorkspaceStatusPicker />)
    expect(optionLabels()).toEqual(['Todo', 'In progress', 'In review', 'Done'])
    expect(selectedLabel()).toBe('In review')
  })

  it('starts on the default status when the workspace has none', () => {
    openPicker({})
    render(<WorkspaceStatusPicker />)
    expect(selectedLabel()).toBe('In progress')
  })

  it('moves the workspace with arrow keys and Enter, on its own host', async () => {
    openPicker({ workspaceStatus: 'todo', hostId: 'ssh:box' })
    render(<WorkspaceStatusPicker />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mocks.updateWorktreeMeta).toHaveBeenCalledOnce())
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(
      'repo::/wt',
      { workspaceStatus: 'in-progress' },
      { executionHostId: 'ssh:box' }
    )
    expect(mocks.closeModal).toHaveBeenCalledOnce()
  })

  it('filters by typing and picks the match with Enter', async () => {
    openPicker({ workspaceStatus: 'todo' })
    render(<WorkspaceStatusPicker />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'done' } })
    await waitFor(() => expect(optionLabels()).toEqual(['Done']))
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mocks.updateWorktreeMeta).toHaveBeenCalledOnce())
    expect(mocks.updateWorktreeMeta.mock.calls[0][1]).toEqual({ workspaceStatus: 'completed' })
    expect(mocks.updateWorktreeMeta.mock.calls[0][2]).toEqual({ executionHostId: 'local' })
  })

  it('only closes when the current status is picked again', () => {
    openPicker({ workspaceStatus: 'in-progress' })
    render(<WorkspaceStatusPicker />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(mocks.closeModal).toHaveBeenCalledOnce()
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('shows a failed write as a toast', async () => {
    mocks.updateWorktreeMeta.mockResolvedValue({ ok: false, error: 'disk full' })
    openPicker({ workspaceStatus: 'todo' })
    render(<WorkspaceStatusPicker />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('disk full'))
  })

  it("offers a paired host's own column to that host's workspaces only", () => {
    const hostOnly = { id: 'blocked', label: 'Blocked' }
    const hostState = {
      hostWorkspaceStatuses: { 'env-2': [hostOnly] },
      removedRuntimeEnvironmentIds: new Set<string>()
    }
    openPicker({ hostId: 'runtime:env-2' }, hostState)
    render(<WorkspaceStatusPicker />)
    expect(optionLabels()).toContain('Blocked')
    cleanup()
    openPicker({ hostId: 'local' }, hostState)
    render(<WorkspaceStatusPicker />)
    expect(optionLabels()).not.toContain('Blocked')
  })

  it('renders nothing while another modal is active', () => {
    openPicker({}, { activeModal: 'none' })
    const { container } = render(<WorkspaceStatusPicker />)
    expect(container.firstChild).toBeNull()
  })
})
