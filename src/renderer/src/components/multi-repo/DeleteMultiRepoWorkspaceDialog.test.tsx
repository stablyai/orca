// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type {
  MultiRepoDeleteInspection,
  MultiRepoDeleteResult
} from '../../../../shared/multi-repo-workspace'
import DeleteMultiRepoWorkspaceDialog from './DeleteMultiRepoWorkspaceDialog'

vi.mock('@/components/sidebar/RemovalUnsavedFilesNotice', () => ({
  RemovalUnsavedFilesNotice: () => null
}))
vi.mock('@/components/editor/removal-unsaved-editor-files', () => ({
  collectRemovalUnsavedFiles: () => []
}))
const toast = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const workspace: FolderWorkspace = {
  id: 'f1',
  projectGroupId: 'g1',
  name: 'checkout-flow',
  folderPath: '/w/f1',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0,
  multiRepo: {
    version: 1,
    executionHostId: 'local',
    rootOwnedByOrca: true,
    members: [
      {
        memberId: 'a',
        repoId: 'repo-a',
        dirName: 'api',
        branchName: 'flow',
        state: 'ready',
        attempts: 1,
        worktreeId: 'wt-a'
      },
      {
        memberId: 'b',
        repoId: 'repo-b',
        dirName: 'web',
        branchName: 'flow',
        state: 'ready',
        attempts: 1,
        worktreeId: 'wt-b'
      }
    ]
  }
}

const clean: MultiRepoDeleteInspection = {
  folderWorkspaceId: 'f1',
  rootPath: '/w/f1',
  rootOwnedByOrca: true,
  members: ['a', 'b'].map((id) => ({
    memberId: id,
    repoId: `repo-${id}`,
    state: 'ready' as const,
    worktreeId: `wt-${id}`,
    worktreeExists: true,
    dirtyCount: 0,
    unpublishedCommitCount: 0,
    willKeepBranch: false
  }))
}

const inspect = vi.fn()
const remove = vi.fn()
const closeModal = vi.fn()

beforeEach(() => {
  inspect.mockReset()
  remove.mockReset()
  closeModal.mockReset()
  toast.info.mockReset()
  useAppStore.setState({
    folderWorkspaces: [workspace],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog reads only repo ids and names.
    repos: [
      { id: 'repo-a', displayName: 'api' },
      { id: 'repo-b', displayName: 'web' }
    ] as never,
    modalData: { folderWorkspaceId: 'f1', executionHostId: 'local' },
    closeModal,
    inspectMultiRepoWorkspaceDelete: inspect,
    deleteMultiRepoWorkspace: remove
  })
})

afterEach(cleanup)

describe('DeleteMultiRepoWorkspaceDialog', () => {
  it('lists every repo and deletes a clean workspace in one confirmation', async () => {
    inspect.mockResolvedValue(clean)
    const result: MultiRepoDeleteResult = {
      folderWorkspaceId: 'f1',
      workspaceRemoved: true,
      remainingMemberCount: 0,
      members: [
        { memberId: 'a', status: 'removed' },
        { memberId: 'b', status: 'removed' }
      ]
    }
    remove.mockResolvedValue(result)
    render(<DeleteMultiRepoWorkspaceDialog />)
    expect(await screen.findByText('Delete checkout-flow?')).toBeTruthy()
    const confirm = await screen.findByRole('button', { name: 'Delete workspace and 2 worktrees' })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(closeModal).toHaveBeenCalled())
    expect(remove).toHaveBeenCalledWith({
      folderWorkspaceId: 'f1',
      executionHostId: 'local'
    })
  })

  it('deletes a workspace whose inspection is ready with no members', async () => {
    inspect.mockResolvedValue({ ...clean, members: [] })
    remove.mockResolvedValue({
      folderWorkspaceId: 'f1',
      workspaceRemoved: true,
      remainingMemberCount: 0,
      members: []
    })
    render(<DeleteMultiRepoWorkspaceDialog />)
    const confirm = await screen.findByRole('button', { name: 'Delete workspace' })
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
    expect(
      screen.getByText('This removes the workspace record and its folder if it is empty.')
    ).toBeTruthy()
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(closeModal).toHaveBeenCalled())
    expect(remove).toHaveBeenCalledWith({ folderWorkspaceId: 'f1', executionHostId: 'local' })
  })

  it('names the repos at risk, sends force only for ticked ones, and counts them in the label', async () => {
    inspect.mockResolvedValue({
      ...clean,
      members: [{ ...clean.members[0], dirtyCount: 3 }, clean.members[1]]
    })
    remove.mockResolvedValue({
      folderWorkspaceId: 'f1',
      workspaceRemoved: true,
      remainingMemberCount: 0,
      members: [
        { memberId: 'a', status: 'removed' },
        { memberId: 'b', status: 'removed' }
      ]
    })
    render(<DeleteMultiRepoWorkspaceDialog />)
    expect(await screen.findByText('3 uncommitted files')).toBeTruthy()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Discard changes in api' }))
    const confirm = await screen.findByRole('button', {
      name: 'Delete and discard changes in 1 repo'
    })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        folderWorkspaceId: 'f1',
        executionHostId: 'local',
        forceMemberIds: ['a']
      })
    )
  })

  it('stays open on a failure with Retry for only the failed repo', async () => {
    inspect.mockResolvedValue(clean)
    remove.mockResolvedValue({
      folderWorkspaceId: 'f1',
      workspaceRemoved: false,
      remainingMemberCount: 1,
      members: [
        { memberId: 'a', status: 'removed' },
        { memberId: 'b', status: 'failed', code: 'busy', message: 'worktree is busy' }
      ]
    })
    render(<DeleteMultiRepoWorkspaceDialog />)
    const confirm = await screen.findByRole('button', { name: 'Delete workspace and 2 worktrees' })
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(await screen.findByText('worktree is busy')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Retry 1 failed' })).toBeTruthy()
    expect(closeModal).not.toHaveBeenCalled()
  })

  it('says when the folder was kept', async () => {
    inspect.mockResolvedValue(clean)
    remove.mockResolvedValue({
      folderWorkspaceId: 'f1',
      workspaceRemoved: true,
      remainingMemberCount: 0,
      rootKept: { path: '/w/f1', reason: 'not_empty' },
      members: [
        { memberId: 'a', status: 'removed' },
        { memberId: 'b', status: 'removed' }
      ]
    })
    render(<DeleteMultiRepoWorkspaceDialog />)
    const confirm = await screen.findByRole('button', { name: 'Delete workspace and 2 worktrees' })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Folder kept: it contains files (/w/f1)')
    )
  })
})
