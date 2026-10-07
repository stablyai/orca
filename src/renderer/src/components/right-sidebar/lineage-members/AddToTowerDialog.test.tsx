// why: the dialog renders through React DOM, so @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import type { Repo } from '../../../../../shared/repo-types'
import { AddToTowerDialog } from './AddToTowerDialog'

const initialAppState = useAppStore.getInitialState()
const originalApi = window.api
const addLink = vi.fn()
const searchBaseRefDetails = vi.fn()
const onChanged = vi.fn()
const onOpenChange = vi.fn()

function repo(id: string, displayName: string, extra: Partial<Repo> = {}): Repo {
  return { id, path: `/repos/${displayName}`, displayName, badgeColor: '', addedAt: 0, ...extra }
}

beforeEach(() => {
  addLink.mockReset()
  searchBaseRefDetails.mockReset()
  onChanged.mockReset()
  onOpenChange.mockReset()
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    repos: [repo('r1', 'loan-core'), repo('r2', 'api'), repo('f1', 'notes', { kind: 'folder' })],
    worktreesByRepo: {
      r1: [
        makeWorktree({
          id: 'r1::/w/loan-core-a',
          repoId: 'r1',
          path: '/w/loan-core-a',
          branch: 'refs/heads/feat/a',
          displayName: 'feature a'
        })
      ],
      r2: [
        makeWorktree({
          id: 'r2::/w/api-b',
          repoId: 'r2',
          path: '/w/api-b',
          branch: 'refs/heads/feat/b',
          displayName: 'feature b'
        })
      ]
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      ...originalApi,
      git: { lineageAddManualLink: addLink },
      repos: { searchBaseRefDetails }
    }
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: originalApi })
})

function renderDialog(): void {
  render(
    <AddToTowerDialog
      open
      onOpenChange={onOpenChange}
      parentWorkspaceKey="folder:tower"
      onChanged={onChanged}
    />
  )
}

function addButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Add' })
}

const PR_PLACEHOLDER = 'https://github.com/org/repo/pull/12 or repo#12'

describe('AddToTowerDialog', () => {
  it('lists every git repo worktree from the store and adds the picked one', async () => {
    addLink.mockResolvedValue({ success: true })
    renderDialog()
    const list = screen.getByRole('listbox')
    expect(within(list).getByText('loan-core')).toBeInTheDocument()
    expect(within(list).getByText('api')).toBeInTheDocument()
    expect(within(list).queryByText('notes')).toBeNull()
    expect(addButton()).toBeDisabled()

    fireEvent.click(within(list).getByText('feature a'))
    fireEvent.click(addButton())

    await waitFor(() =>
      expect(addLink).toHaveBeenCalledWith({
        parentWorkspaceKey: 'folder:tower',
        target: { kind: 'worktree', repoId: 'r1', worktreePath: '/w/loan-core-a' }
      })
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('picks a repo, then a branch listed by the host, and adds it', async () => {
    addLink.mockResolvedValue({ success: true })
    searchBaseRefDetails.mockResolvedValue([
      { refName: 'origin/feat/x', localBranchName: 'feat/x' },
      { refName: 'feat/x', localBranchName: 'feat/x' },
      { refName: 'feat/y', localBranchName: 'feat/y' }
    ])
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Branch' }))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('loan-core'))

    await waitFor(() =>
      expect(searchBaseRefDetails).toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'r1', query: '' })
      )
    )
    const branches = await screen.findAllByText('feat/x')
    expect(branches).toHaveLength(1)
    fireEvent.click(branches[0])
    fireEvent.click(addButton())

    await waitFor(() =>
      expect(addLink).toHaveBeenCalledWith({
        parentWorkspaceKey: 'folder:tower',
        target: { kind: 'branch', repoId: 'r1', branch: 'feat/x' }
      })
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('adds a pull request by URL or repo#n, sending the legacy reference too', async () => {
    addLink.mockResolvedValue({ success: true })
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Pull request' }))
    fireEvent.change(screen.getByPlaceholderText(PR_PLACEHOLDER), {
      target: { value: ' api#12 ' }
    })
    fireEvent.click(addButton())
    await waitFor(() =>
      expect(addLink).toHaveBeenCalledWith({
        parentWorkspaceKey: 'folder:tower',
        reference: 'api#12',
        target: { kind: 'pr', reference: 'api#12' }
      })
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('keeps the dialog open with the host error inline', async () => {
    addLink.mockResolvedValue({ success: false, error: 'Repository not registered in Orca' })
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Pull request' }))
    fireEvent.change(screen.getByPlaceholderText(PR_PLACEHOLDER), {
      target: { value: 'nope#1' }
    })
    fireEvent.click(addButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Repository not registered in Orca')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('shows the error when the IPC call rejects', async () => {
    addLink.mockRejectedValue(new Error('boom'))
    renderDialog()
    fireEvent.click(within(screen.getByRole('listbox')).getByText('feature b'))
    fireEvent.click(addButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })
})
