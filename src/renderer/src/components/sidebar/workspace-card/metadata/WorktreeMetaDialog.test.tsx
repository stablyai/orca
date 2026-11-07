// @vitest-environment happy-dom
import { act, createContext, useContext, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { WorktreeMetaUpdateOptions } from '@/store/slices/worktree-helpers'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const Selection = createContext<(value: string) => void>(() => {})
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange
    }: {
      children?: ReactNode
      onValueChange: (value: string) => void
    }) => <Selection.Provider value={onValueChange}>{children}</Selection.Provider>,
    DropdownMenuRadioItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const select = useContext(Selection)
      return (
        <button type="button" onClick={() => select(value)}>
          {children}
        </button>
      )
    }
  }
})
vi.mock('@/runtime/linear/runtime-linear-client', () => ({
  linearStatus: vi.fn(async () => ({ connected: false, viewer: null }))
}))
import WorktreeMetaDialog from './WorktreeMetaDialog'

const initialState = useAppStore.getInitialState()
const updateWorktreeMeta =
  vi.fn<
    (
      id: string,
      updates: Partial<WorktreeMeta>,
      options?: WorktreeMetaUpdateOptions
    ) => Promise<{ ok: true } | { ok: false; error: string }>
  >()
const openUrl = vi.fn()
function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/repo/worktrees/feature',
    repoId: 'repo',
    path: '/repo/worktrees/feature',
    displayName: 'Feature work',
    branch: 'feature',
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    comment: 'existing note',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}
function openDialog(
  overrides: Partial<Worktree> = {},
  modal: Record<string, unknown> = {}
): Worktree {
  const item = worktree(overrides)
  useAppStore.setState({
    repos: [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'orca',
        badgeColor: '',
        addedAt: 1,
        ...(overrides.hostId ? { executionHostId: overrides.hostId } : {}),
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/orca',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/acme/orca.git'
        }
      }
    ],
    worktreesByRepo: { repo: [item] },
    activeModal: 'edit-meta',
    modalData: {
      worktreeId: item.id,
      repoId: item.repoId,
      currentDisplayName: item.displayName,
      currentComment: item.comment,
      focus: 'comment',
      ...modal
    },
    updateWorktreeMeta
  })
  render(<WorktreeMetaDialog />)
  return item
}
function input(): HTMLElement {
  const field = screen.getByRole('combobox', { name: 'Search references' })
  act(() => field.focus())
  return field
}
async function add(value: string, kind?: string): Promise<void> {
  const field = input()
  fireEvent.change(field, { target: { value } })
  if (kind) {
    fireEvent.click(screen.getByRole('button', { name: kind }))
  }
  const command = await screen.findByRole('option', { name: /^Add (PR|Issue|MR|STA)/ })
  await waitFor(() => expect(command.getAttribute('data-disabled')).not.toBe('true'))
  fireEvent.click(command)
}
async function save(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalled())
}

describe('workspace linked work editor', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      fetchWorkItems: vi.fn(async () => []),
      getCachedWorkItems: vi.fn(() => []),
      refreshPreflightStatus: vi.fn(async () => {}),
      checkLinearConnection: vi.fn(async () => {}),
      readJiraStatus: vi.fn(async () => ({ connected: false, viewer: null, sites: [] })),
      linearStatusChecked: true
    })
    Element.prototype.scrollIntoView = vi.fn()
    updateWorktreeMeta.mockReset().mockResolvedValue({ ok: true })
    openUrl.mockReset()
    Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
  })
  afterEach(cleanup)
  it('resets the draft when another host opens the same workspace ID', async () => {
    const original = openDialog({ linkedIssue: 1 }, { executionHostId: 'local' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Local draft' }
    })
    await add('https://github.com/acme/orca/issues/3')
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            original,
            { ...original, hostId: 'ssh:other', linkedIssue: 2, comment: 'Remote note' }
          ]
        },
        modalData: {
          worktreeId: original.id,
          repoId: 'repo',
          executionHostId: 'ssh:other',
          focus: 'comment'
        }
      })
    )
    expect(screen.getByText('Issue #2')).toBeTruthy()
    expect(screen.queryByText('Issue #1')).toBeNull()
    expect(screen.queryByText('Issue #3')).toBeNull()
    expect(
      screen.getByRole('textbox', { name: 'Notes' }).getAttribute('value') ??
        screen.getByRole('textbox', { name: 'Notes' }).textContent
    ).toBe('Remote note')
    await save()
    expect(updateWorktreeMeta.mock.calls[0]).toEqual([
      original.id,
      {},
      { executionHostId: 'ssh:other' }
    ])
  })
  it('does not close a new owner’s draft when an earlier save completes', async () => {
    const original = openDialog({}, { executionHostId: 'local' })
    const pending = Promise.withResolvers<{ ok: true }>()
    updateWorktreeMeta.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateWorktreeMeta).toHaveBeenCalledOnce()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [original, { ...original, hostId: 'ssh:other', comment: 'Remote draft' }]
        },
        modalData: {
          worktreeId: original.id,
          repoId: 'repo',
          executionHostId: 'ssh:other',
          focus: 'comment'
        }
      })
    )
    await act(async () => pending.resolve({ ok: true }))
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('textbox', { name: 'Notes' }).textContent).toBe('Remote draft')
  })
})
