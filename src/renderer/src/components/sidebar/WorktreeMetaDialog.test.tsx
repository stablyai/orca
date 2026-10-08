// @vitest-environment happy-dom
import { act, createContext, useContext, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeMetaUpdateOptions } from '@/store/slices/worktree-helpers'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

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
vi.mock('@/runtime/runtime-linear-client', () => ({
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

  it('adds multiple reviews and tasks without displacing existing links', async () => {
    openDialog({ linkedPR: 1, linkedIssue: 2 })
    await add('3', 'GitHub PR')
    await add('STA-4', 'Linear task')
    expect(screen.getByText('PR #1')).toBeTruthy()
    expect(screen.getByText('PR #3')).toBeTruthy()
    expect(screen.getByText('Issue #2')).toBeTruthy()
    expect(screen.getByText('STA-4')).toBeTruthy()
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1].linkedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'github', type: 'pr', number: 1 }),
        expect.objectContaining({ provider: 'github', type: 'pr', number: 3 }),
        expect.objectContaining({ provider: 'linear', identifier: 'STA-4' })
      ])
    )
  })
  it('adds a pasted URL according to its provider and type', async () => {
    openDialog()
    act(() =>
      useAppStore.setState({
        repos: [
          {
            id: 'repo',
            path: '/repo',
            displayName: 'orca',
            badgeColor: '',
            addedAt: 1,
            gitRemoteIdentity: {
              canonicalKey: 'gitlab.example.com/team/orca',
              remoteName: 'origin',
              remoteUrl: 'https://gitlab.example.com/team/orca.git'
            }
          }
        ]
      })
    )
    await add('https://gitlab.example.com/team/orca/-/merge_requests/12')
    expect(screen.getByText('MR !12')).toBeTruthy()
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1].linkedItems).toEqual([
      expect.objectContaining({ provider: 'gitlab', type: 'mr', number: 12 })
    ])
  })
  it('shows an existing reference as linked', async () => {
    openDialog({ linkedIssue: 42 })
    fireEvent.change(input(), { target: { value: '#42' } })
    expect(await screen.findByText('Linked')).toBeTruthy()
    expect(screen.getAllByText('Issue #42')).toHaveLength(1)
  })
  it('unlinks only the chosen item', async () => {
    openDialog({
      linkedPR: 1,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 1 },
        { provider: 'github', type: 'pr', number: 2 }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink PR #2' }))
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1].linkedItems).toEqual([
      { provider: 'github', type: 'pr', number: 1 }
    ])
  })
  it('keeps all reviews without exposing a checks selector', async () => {
    openDialog({
      linkedPR: 1,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 1 },
        { provider: 'github', type: 'pr', number: 2 }
      ]
    })
    expect(screen.queryByRole('button', { name: /Use .* for checks/ })).toBeNull()
    expect(screen.queryByText('Used for checks')).toBeNull()
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1]).toEqual({})
  })
  it('unlinks a review without overriding another client’s concurrently selected review', async () => {
    const original = openDialog({
      linkedPR: 1,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 1 },
        { provider: 'github', type: 'pr', number: 2 }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink PR #1' }))
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            {
              ...original,
              linkedPR: 3,
              linkedItems: [
                ...(original.linkedItems ?? []),
                { provider: 'github', type: 'pr', number: 3 }
              ]
            }
          ]
        }
      })
    )
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1]).toEqual({
      linkedItemsBase: original.linkedItems,
      linkedItems: [{ provider: 'github', type: 'pr', number: 2 }]
    })
  })
  it('passes the original snapshot so persistence can preserve background additions', async () => {
    const original = openDialog({ linkedIssue: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Issue #1' }))
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            {
              ...original,
              linkedItems: [
                { provider: 'github', type: 'issue', number: 1 },
                { provider: 'github', type: 'issue', number: 2 }
              ]
            }
          ]
        }
      })
    )
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1]).toEqual({
      linkedItemsBase: [{ provider: 'github', type: 'issue', number: 1 }],
      linkedItems: []
    })
  })
  it('omits untouched links on comment-only saves', async () => {
    openDialog({ linkedIssue: 1, linkedLinearIssue: 'STA-2' })
    fireEvent.change(screen.getByPlaceholderText('Notes about this worktree...'), {
      target: { value: 'new note' }
    })
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1]).toEqual({ comment: 'new note' })
  })
  it('keeps the draft and error visible after a failed save', async () => {
    updateWorktreeMeta.mockResolvedValue({ ok: false, error: 'Host is disconnected' })
    openDialog()
    await add('4')
    await save()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Host is disconnected')
    expect(alert.parentElement?.contains(screen.getByRole('button', { name: 'Save' }))).toBe(true)
    expect(screen.getByText('Issue #4')).toBeTruthy()
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
  })
  it('supports folder workspace links', async () => {
    const folder: FolderWorkspace = {
      id: 'folder-1',
      projectGroupId: 'group',
      name: 'Docs',
      folderPath: '/docs',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    useAppStore.setState({ folderWorkspaces: [folder] })
    openDialog({}, { worktreeId: folderWorkspaceKey(folder.id), repoId: undefined })
    await add('STA-5', 'Linear task')
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[0]).toBe(folderWorkspaceKey(folder.id))
    expect(updateWorktreeMeta.mock.calls[0]?.[1].linkedItems).toEqual([
      expect.objectContaining({ provider: 'linear', identifier: 'STA-5' })
    ])
  })
  it('preserves the execution host in a metadata save', async () => {
    openDialog({ hostId: 'runtime:host-1' }, { executionHostId: 'runtime:host-1' })
    await add('4')
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[2]).toEqual({ executionHostId: 'runtime:host-1' })
  })
  it('Enter adds another link and leaves the editor open', async () => {
    openDialog()
    const field = input()
    fireEvent.change(field, { target: { value: 'https://github.com/acme/orca/issues/4' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.queryByText('Issue #4')).toBeNull()
    const command = await screen.findByRole('option', { name: 'Add Issue #4' })
    await waitFor(() => expect(command.getAttribute('data-disabled')).not.toBe('true'))
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByText('Issue #4')).toBeTruthy()
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })
  it('does not add during an IME composition gesture', () => {
    openDialog()
    const field = input()
    fireEvent.change(field, { target: { value: '4' } })
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(screen.queryByText('Issue #4')).toBeNull()
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })
  it.each([
    { key: 'Enter', keyCode: 13, isComposing: true },
    { key: 'Enter', keyCode: 229 },
    { key: 'Enter', keyCode: 13 }
  ])('keeps notes open through IME confirmation and redispatch: %j', async (event) => {
    openDialog()
    const notes = screen.getByRole('textbox', { name: 'Notes' })
    fireEvent.compositionStart(notes)
    fireEvent.change(notes, { target: { value: '確定' } })
    fireEvent.keyDown(notes, event)
    fireEvent.compositionEnd(notes)
    fireEvent.keyUp(notes, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(notes, { key: 'Enter', keyCode: 13 })
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
    fireEvent.keyDown(notes, { key: 'Enter', keyCode: 13 })
    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalled())
    expect(updateWorktreeMeta.mock.calls[0]?.[1].comment).toBe('確定')
  })
  it('saves selected drafts while leaving search text unattached', async () => {
    openDialog({ linkedIssue: 1 })
    await add('https://github.com/acme/orca/issues/4')
    fireEvent.change(input(), { target: { value: '42' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Select a result to attach it.')).toBeTruthy()
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1].linkedItems).toEqual([
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ number: 4 })
    ])
  })
  it('blocks known foreign issue URLs with an explanation', () => {
    openDialog()
    fireEvent.change(input(), {
      target: { value: 'https://github.com/other/project/issues/4' }
    })
    expect(
      screen.getByRole('option', { name: /^Add / }).getAttribute('aria-disabled') === 'true'
    ).toBe(true)
    expect(
      screen.getByText(
        'This issue belongs to another repository. Add issues from this workspace’s repository.'
      )
    ).toBeTruthy()
  })
  it('blocks known foreign review URLs with an explanation', () => {
    openDialog()
    fireEvent.change(input(), {
      target: { value: 'https://github.com/other/project/pull/4' }
    })
    expect(
      screen.getByRole('option', { name: /^Add / }).getAttribute('aria-disabled') === 'true'
    ).toBe(true)
    expect(
      screen.getByText(
        'This review belongs to another repository. Add reviews from this workspace’s repository.'
      )
    ).toBeTruthy()
  })
  it('clears search with captured Escape before the next Escape closes details', () => {
    openDialog()
    const field = input()
    fireEvent.change(field, { target: { value: 'unselected search' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('combobox')).toBe(field)
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(useAppStore.getState().activeModal).toBe('none')
  })
  it('keeps real GitLab-enabled controller effects bounded in Smart mode', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    openDialog({ hostId: 'ssh:test-host' })
    input()
    await waitFor(() => expect(useAppStore.getState().fetchWorkItems).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('tab', { name: 'GitLab' })).toBeTruthy()
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Maximum update depth')
    errors.mockRestore()
  })
  it('adds a searched issue with title and source context and stays ready for another', async () => {
    useAppStore.setState({
      fetchWorkItems: vi.fn(async (): Promise<GitHubWorkItem[]> => [
        {
          id: 'issue-71',
          repoId: 'repo',
          type: 'issue',
          number: 71,
          title: 'Searchable issue',
          state: 'open',
          url: 'https://github.com/acme/orca/issues/71',
          labels: [],
          updatedAt: '2026-10-05',
          author: null
        }
      ])
    })
    openDialog()
    const field = input()
    fireEvent.change(field, { target: { value: 'Searchable' } })
    await screen.findByRole('option', { name: /Searchable issue/ })
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Searchable issue/ }).getAttribute('data-disabled')
      ).not.toBe('true')
    )
    fireEvent.click(screen.getByRole('option', { name: /Searchable issue/ }))
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(field).toBeInstanceOf(HTMLInputElement)
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('Expected reference input')
    }
    expect(field.value).toBe('')
    await save()
    expect(updateWorktreeMeta.mock.calls[0]?.[1].linkedItems).toEqual([
      expect.objectContaining({
        number: 71,
        title: 'Searchable issue',
        taskSourceContext: expect.objectContaining({
          provider: 'github',
          providerIdentity: expect.objectContaining({ owner: 'acme', repo: 'orca' })
        })
      })
    ])
  })
  it('does not select a held result after typing a different query', async () => {
    useAppStore.setState({
      fetchWorkItems: vi.fn(async (): Promise<GitHubWorkItem[]> => [
        {
          id: 'issue-71',
          repoId: 'repo',
          type: 'issue',
          number: 71,
          title: 'Old result',
          state: 'open',
          url: 'https://github.com/acme/orca/issues/71',
          labels: [],
          updatedAt: '2026-10-05',
          author: null
        }
      ])
    })
    openDialog()
    const field = input()
    fireEvent.change(field, { target: { value: 'Old' } })
    const result = await screen.findByRole('option', { name: /Old result/ })
    fireEvent.change(field, { target: { value: 'new query' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(result)
    expect(screen.getByText('0 linked')).toBeTruthy()
  })
  it('stops cmdk from adding an IME-owned unmarked Enter', () => {
    openDialog()
    const field = input()
    fireEvent.change(field, { target: { value: 'https://github.com/acme/orca/issues/71' } })
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13, isComposing: false })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(screen.getByText('0 linked')).toBeTruthy()
  })

  it('focuses an inline suggested review without assuming it has been attached', () => {
    openDialog({}, { focus: 'pr', currentReview: 42 })
    expect(screen.getByRole('combobox', { name: 'Search references' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('option', { name: 'Add PR #42' })).toBeTruthy()
  })
  it('keeps search inside the single details dialog and starts with no result overlay', () => {
    openDialog()
    const field = input()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog').contains(field)).toBe(true)
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByText('0 linked')).toBeTruthy()
  })
  it('clears results explicitly and preserves the selected drafts', async () => {
    openDialog()
    await add('https://github.com/acme/orca/issues/4')
    fireEvent.change(input(), { target: { value: 'unselected' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.getByText('Issue #4')).toBeTruthy()
    expect(document.activeElement).toBe(input())
  })
  it('cancels added references without a metadata write', async () => {
    openDialog()
    await add('https://github.com/acme/orca/issues/4')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('none')
  })
  it('keeps empty notes collapsed for link focus and preserves existing notes', () => {
    openDialog({ comment: '' }, { focus: 'links' })
    expect(screen.queryByRole('textbox', { name: 'Notes' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add notes' }))
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Notes' }))
  })
  it('preserves name and comment autofocus while search remains inline', () => {
    openDialog({}, { focus: 'displayName' })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Display Name' }))
  })
  it('does not dismiss the dialog when Escape belongs to IME composition', () => {
    openDialog()
    const field = input()
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Escape', isComposing: false })
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
    fireEvent.compositionEnd(field)
  })
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
