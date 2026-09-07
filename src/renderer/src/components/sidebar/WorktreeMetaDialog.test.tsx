// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeMetaUpdateOptions } from '@/store/slices/worktree-helpers'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

// Why: Radix tooltips need a provider the dialog does not own, and the menu's
// portal needs real layout. Stand-ins keep these tests on provider selection.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<(value: string) => void>(() => {})
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuRadioGroup: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children?: ReactNode
    }) => (
      <SelectContext.Provider value={onValueChange}>
        <div data-selected={value}>{children}</div>
      </SelectContext.Provider>
    ),
    DropdownMenuRadioItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const onSelect = React.useContext(SelectContext)
      return (
        <button type="button" role="menuitemradio" onClick={() => onSelect(value)}>
          {children}
        </button>
      )
    }
  }
})

import WorktreeMetaDialog from './WorktreeMetaDialog'

const REPO_ID = 'repo-1'
const WORKTREE_ID = 'repo-1::/repo/worktrees/feature'

const initialState = useAppStore.getInitialState()
const updateWorktreeMeta =
  vi.fn<
    (
      id: string,
      updates: Partial<WorktreeMeta>,
      options?: WorktreeMetaUpdateOptions
    ) => Promise<{ ok: true } | { ok: false; error: string }>
  >()
const fetchLinearIssue = vi.fn<(...args: never[]) => Promise<LinearIssue | null>>()
const openUrl = vi.fn<(url: string) => void>()

/** Only `url` is read by the open-issue path. */
function makeLinearIssue(url: string): LinearIssue {
  return { url } as LinearIssue
}

function makeRepo(id: string = REPO_ID, path: string = '/repo'): Repo {
  return { id, path, displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: REPO_ID,
    path: '/repo/worktrees/feature',
    displayName: 'Feature work',
    branch: 'feature',
    head: 'abc123',
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

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'pg-1',
    name: 'Docs folder',
    folderPath: '/repo/docs',
    linkedTask: {
      provider: 'linear',
      type: 'issue',
      number: 901,
      title: 'Fix auth',
      url: 'https://linear.app/acme/issue/STA-901',
      linearIdentifier: 'STA-901'
    },
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function openDialog(
  options: {
    worktree?: Partial<Worktree>
    worktreeId?: string
    folderWorkspace?: Partial<FolderWorkspace>
    /** Extra owners of the same workspace ID, which the index reads as ambiguous. */
    otherRepos?: { repoId: string; worktree?: Partial<Worktree> }[]
    modalRepoId?: string
    modalExecutionHostId?: string
    modalReviewProvider?: 'github' | 'gitlab'
    modalCurrentReview?: number
    modalSuppressHostedReviewRefresh?: boolean
    linearViewerOrganizationUrlKey?: string
  } = {}
): void {
  const worktree = makeWorktree(options.worktree)
  const otherRepos = options.otherRepos ?? []
  useAppStore.setState({
    repos: [makeRepo(), ...otherRepos.map((other) => makeRepo(other.repoId, `/${other.repoId}`))],
    worktreesByRepo: {
      [REPO_ID]: [worktree],
      ...Object.fromEntries(
        otherRepos.map((other) => [
          other.repoId,
          [makeWorktree({ repoId: other.repoId, ...other.worktree })]
        ])
      )
    },
    ...(options.folderWorkspace
      ? { folderWorkspaces: [makeFolderWorkspace(options.folderWorkspace)] }
      : {}),
    ...(options.linearViewerOrganizationUrlKey
      ? {
          linearStatus: {
            connected: true,
            viewer: {
              displayName: 'Viewer',
              email: null,
              organizationName: 'Active',
              organizationUrlKey: options.linearViewerOrganizationUrlKey
            }
          }
        }
      : {}),
    activeModal: 'edit-meta',
    modalData: {
      worktreeId: options.worktreeId ?? worktree.id,
      ...(options.modalRepoId ? { repoId: options.modalRepoId } : {}),
      ...(options.modalExecutionHostId ? { executionHostId: options.modalExecutionHostId } : {}),
      ...(options.modalReviewProvider ? { reviewProvider: options.modalReviewProvider } : {}),
      ...(options.modalCurrentReview ? { currentReview: options.modalCurrentReview } : {}),
      ...(options.modalSuppressHostedReviewRefresh ? { suppressHostedReviewRefresh: true } : {}),
      currentDisplayName: worktree.displayName,
      currentComment: worktree.comment,
      focus: 'comment'
    },
    updateWorktreeMeta,
    fetchLinearIssue: fetchLinearIssue as unknown as ReturnType<
      typeof useAppStore.getState
    >['fetchLinearIssue']
  })
  render(<WorktreeMetaDialog />)
}

function issueInput(): HTMLInputElement {
  return screen.getByPlaceholderText('Issue #, or a GitHub or Linear URL')
}

function providerChip(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Issue provider' })
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save' })
}

function openIssueButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Open linked issue' })
}

describe('WorktreeMetaDialog issue link row', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    updateWorktreeMeta.mockReset()
    updateWorktreeMeta.mockResolvedValue({ ok: true })
    fetchLinearIssue.mockReset()
    fetchLinearIssue.mockResolvedValue(null)
    openUrl.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: { openUrl } }
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('seeds the chip and value from a GitHub link', () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    expect(providerChip().textContent).toContain('GitHub')
    expect(issueInput().value).toBe('42')
  })

  it('seeds and saves the GitLab MR row through the GitLab slot', async () => {
    openDialog({
      worktree: { linkedGitLabMR: 42 },
      modalReviewProvider: 'gitlab',
      modalCurrentReview: 42,
      modalSuppressHostedReviewRefresh: true
    })
    const input = screen.getByPlaceholderText('MR ! or GitLab URL')

    expect(screen.getByText('GitLab MR')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('42')
    fireEvent.change(input, { target: { value: '!43' } })
    await act(async () => fireEvent.click(saveButton()))

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    expect(updateWorktreeMeta.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ linkedGitLabMR: 43 })
    )
    expect(updateWorktreeMeta.mock.calls[0]?.[1]).not.toHaveProperty('linkedPR')
    expect(updateWorktreeMeta.mock.calls[0]?.[2]).toEqual({ suppressHostedReviewRefresh: true })
  })

  it('replaces a completed emoji shortcode in the display name', () => {
    openDialog()
    const displayNameInput = screen.getByRole('textbox', { name: 'Display Name' })

    fireEvent.change(displayNameInput, {
      target: { value: 'Feature :wink:', selectionStart: 14 }
    })

    expect((displayNameInput as HTMLInputElement).value).toBe('Feature 😉')
  })

  it('seeds the chip and value from a Linear link', () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    expect(providerChip().textContent).toContain('Linear')
    expect(issueInput().value).toBe('STA-335')
  })

  it('flips to Linear when a linear.app issue URL is pasted', () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    fireEvent.change(issueInput(), {
      target: { value: 'https://linear.app/acme/issue/STA-335/fix-the-thing' }
    })

    expect(providerChip().textContent).toContain('Linear')
  })

  // Why: Linear and Jira issue keys are the same shape, so only a URL may steer
  // the provider — a bare key must never override the user's explicit choice.
  it('keeps the chip on GitHub when a bare issue key is typed', () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    fireEvent.change(issueInput(), { target: { value: 'GH-1234' } })

    expect(providerChip().textContent).toContain('GitHub')
    expect(providerChip().textContent).not.toContain('Linear')
  })

  it('flips to GitHub when a GitHub issue URL is pasted over a Linear link', () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.change(issueInput(), {
      target: { value: 'https://github.com/acme/orca/issues/77' }
    })

    expect(providerChip().textContent).toContain('GitHub')
  })

  it('names the Linear issue that switching to GitHub would unlink', () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GitHub' }))
    fireEvent.change(issueInput(), { target: { value: '99' } })

    expect(
      screen.getByText('Saving unlinks Linear STA-335 — a workspace tracks one issue.')
    ).toBeTruthy()
  })

  // Both slots can hold a link at once — naming only one understates the save.
  it('names both links when clearing the field would drop both', () => {
    openDialog({ worktree: { linkedIssue: 42, linkedLinearIssue: 'STA-335' } })

    fireEvent.change(issueInput(), { target: { value: '' } })

    expect(
      screen.getByText(
        'Saving unlinks Linear STA-335 and GitHub #42 — a workspace tracks one issue.'
      )
    ).toBeTruthy()
  })

  // The warning above only promises the displacement — this asserts the payload
  // that carries it out, which is where the one-issue-per-workspace rule lives.
  it('clears the displaced GitHub link when a Linear value is saved', async () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Linear' }))
    fireEvent.change(issueInput(), { target: { value: 'STA-335' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(updates.linkedLinearIssue).toBe('STA-335')
    expect(updates.linkedIssue).toBeNull()
  })

  // A GitHub-only save must carry no Linear keys: persistence gates the remote
  // Linear capability on key presence, so a synthetic clear fails the save.
  it('sends no Linear keys when the workspace has no Linear link', async () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    fireEvent.change(issueInput(), { target: { value: '99' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(updates.linkedIssue).toBe(99)
    expect(updates).not.toHaveProperty('linkedLinearIssue')
  })
  it('qualifies a save with the host selected by the opening row', async () => {
    openDialog({
      worktree: { hostId: 'ssh:build-box' },
      modalExecutionHostId: 'ssh:build-box'
    })

    fireEvent.change(screen.getByPlaceholderText('Notes about this worktree...'), {
      target: { value: 'remote note' }
    })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() =>
      expect(updateWorktreeMeta).toHaveBeenCalledWith(
        WORKTREE_ID,
        expect.objectContaining({ comment: 'remote note' }),
        { executionHostId: 'ssh:build-box' }
      )
    )
  })

  // updateWorktreeMeta stamps lastActivityAt on any comment write, which would
  // reorder the workspace under the time-decay sidebar sort.
  it('sends no comment when only the issue link changed', async () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.change(issueInput(), { target: { value: 'STA-999' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    expect(updateWorktreeMeta.mock.calls[0]?.[1] ?? {}).not.toHaveProperty('comment')
  })

  // A failed save refetches and reverts the optimistic write, so closing here
  // would report success for an edit that silently undid itself.
  it('keeps the dialog open and reports why when the save fails', async () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })
    updateWorktreeMeta.mockResolvedValue({ ok: false, error: 'Runtime is offline' })

    fireEvent.change(issueInput(), { target: { value: 'STA-999' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    expect(screen.getByRole('alert').textContent).toBe('Runtime is offline')
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
  })

  it('leaves the Linear link alone when only the comment is edited', async () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.change(screen.getByPlaceholderText('Notes about this worktree...'), {
      target: { value: 'updated note' }
    })

    expect(screen.queryByText(/Saving unlinks/)).toBeNull()

    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(Object.keys(updates)).not.toContain('linkedLinearIssue')
    expect(Object.keys(updates)).not.toContain('linkedIssue')
    expect(updates.comment).toBe('updated note')
  })

  it('blocks saving an unparseable Linear value', () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.change(issueInput(), { target: { value: 'not an issue' } })

    expect(screen.getByText('Not a Linear issue key or linear.app issue URL.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  })

  it('is read-only for a folder workspace', () => {
    openDialog({ worktreeId: folderWorkspaceKey('fw-1') })

    expect(issueInput().disabled).toBe(true)
    expect(providerChip().disabled).toBe(true)
    expect(
      screen.getByText(
        "Issue links are set when a folder workspace is created and can't be changed here yet."
      )
    ).toBeTruthy()
  })

  // Folder workspaces live outside worktreesByRepo, so the indexed lookup alone
  // leaves the row blank and the link it does hold looks lost.
  it('shows a folder workspace its own linked issue', () => {
    openDialog({ worktreeId: folderWorkspaceKey('fw-1'), folderWorkspace: {} })

    expect(issueInput().value).toBe('STA-901')
    expect(providerChip().textContent).toContain('Linear')
  })

  // A background `orca worktree set` must not move the baseline mid-edit: the
  // field would read as dirty and a comment-only save would write the stale seed.
  it('keeps the baseline frozen when the store changes while open', async () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    act(() => {
      useAppStore.setState({
        worktreesByRepo: {
          [REPO_ID]: [makeWorktree({ linkedLinearIssue: 'STA-999' })]
        }
      })
    })
    fireEvent.change(screen.getByPlaceholderText('Notes about this worktree...'), {
      target: { value: 'still working' }
    })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(updates.comment).toBe('still working')
    expect(updates).not.toHaveProperty('linkedLinearIssue')
    expect(updates).not.toHaveProperty('linkedIssue')
  })

  // A bare key names no organization. Building one from the connected viewer
  // opens a not-found page — or a colliding issue — for every other workspace
  // the user belongs to, and skips the lookup that would have said so.
  it('resolves a bare Linear key across workspaces rather than the active organization', async () => {
    fetchLinearIssue.mockResolvedValue(makeLinearIssue('https://linear.app/other/issue/STA-999'))
    openDialog({
      worktree: { linkedLinearIssue: 'STA-335' },
      linearViewerOrganizationUrlKey: 'active-org'
    })

    fireEvent.change(issueInput(), { target: { value: 'STA-999' } })
    await act(async () => {
      fireEvent.click(openIssueButton())
    })

    expect(fetchLinearIssue.mock.calls[0]?.slice(0, 2)).toEqual(['STA-999', 'all'])
    expect(openUrl).toHaveBeenCalledWith('https://linear.app/other/issue/STA-999')
  })

  // The stored key belongs to the persisted identifier, so it stays authoritative
  // for it — no lookup, no round trip.
  it('opens a stored Linear link directly from its organization key', async () => {
    openDialog({
      worktree: {
        linkedLinearIssue: 'STA-335',
        linkedLinearIssueOrganizationUrlKey: 'acme'
      },
      linearViewerOrganizationUrlKey: 'active-org'
    })

    await act(async () => {
      fireEvent.click(openIssueButton())
    })

    expect(fetchLinearIssue).not.toHaveBeenCalled()
    expect(openUrl).toHaveBeenCalledWith('https://linear.app/acme/issue/STA-335')
  })

  // Promise.race cannot cancel the lookup, and the field stays editable while it
  // runs — a late result must not open the issue the user just replaced.
  it('does not open a lookup result after the field moved on', async () => {
    let resolveLookup: ((issue: LinearIssue | null) => void) | undefined
    fetchLinearIssue.mockReturnValue(
      new Promise<LinearIssue | null>((resolve) => {
        resolveLookup = resolve
      })
    )
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.change(issueInput(), { target: { value: 'STA-999' } })
    fireEvent.click(openIssueButton())
    fireEvent.change(issueInput(), { target: { value: 'STA-777' } })
    await act(async () => {
      resolveLookup?.(makeLinearIssue('https://linear.app/acme/issue/STA-999'))
    })

    expect(openUrl).not.toHaveBeenCalled()
    expect(
      screen.queryByText(
        "Couldn't open that issue. Check the identifier and your Linear connection."
      )
    ).toBeNull()
  })

  // Displacement is decided at save time, not at open: a link added by the CLI
  // while the dialog sat open must not outlive the save that warned about it.
  it('clears a Linear link added while the dialog was open', async () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    act(() => {
      useAppStore.setState({
        worktreesByRepo: {
          [REPO_ID]: [makeWorktree({ linkedIssue: 42, linkedLinearIssue: 'STA-999' })]
        }
      })
    })
    fireEvent.change(issueInput(), { target: { value: '99' } })

    expect(
      screen.getByText('Saving unlinks Linear STA-999 — a workspace tracks one issue.')
    ).toBeTruthy()

    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(updates.linkedIssue).toBe(99)
    expect(updates.linkedLinearIssue).toBeNull()
  })

  // Same issue, different spelling: the link is unchanged, so its title and
  // SSH/runtime source context must survive the save.
  it('keeps the linked work item when the value is only respelled', async () => {
    openDialog({
      worktree: {
        linkedLinearIssue: 'STA-335',
        linkedWorkItem: {
          provider: 'linear',
          type: 'issue',
          number: 335,
          title: 'Fix auth',
          url: 'https://linear.app/acme/issue/STA-335'
        }
      }
    })

    fireEvent.change(issueInput(), { target: { value: 'sta-335' } })

    expect(screen.queryByText(/Saving unlinks/)).toBeNull()

    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(updates).not.toHaveProperty('linkedWorkItem')
    expect(updates).not.toHaveProperty('linkedTaskSourceContext')
    expect(updates).not.toHaveProperty('linkedLinearIssue')
  })

  // The owner index reports a duplicated workspace ID as ambiguous rather than
  // guessing, so the opening row has to name its own bucket.
  it('shows the clicked row when the same workspace ID exists under two hosts', () => {
    openDialog({
      worktree: { linkedIssue: 42 },
      otherRepos: [{ repoId: 'repo-2', worktree: { linkedIssue: 77 } }],
      modalRepoId: 'repo-2'
    })

    expect(issueInput().value).toBe('77')
    expect(providerChip().textContent).toContain('GitHub')
  })

  it('dispatches nothing when the dialog is cancelled', async () => {
    openDialog({ worktree: { linkedLinearIssue: 'STA-335' } })

    fireEvent.change(issueInput(), { target: { value: '99' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('none')
  })
})
