// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { MultiRepoMemberDeleteNote, RemoveFromWorkspaceMenuItem } from './MultiRepoMemberNotices'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
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
    members: ['a', 'b', 'c'].map((id) => ({
      memberId: id,
      repoId: `repo-${id}`,
      dirName: id,
      branchName: 'flow',
      state: 'ready' as const,
      attempts: 1,
      worktreeId: `wt-${id}`
    }))
  }
}

const runMemberAction = vi.fn()

beforeEach(() => {
  runMemberAction.mockReset()
  toast.mockReset()
  toast.error.mockReset()
  useAppStore.setState({
    folderWorkspaces: [workspace],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notices read only repo ids and names.
    repos: [{ id: 'repo-b', displayName: 'web' }] as never,
    runMultiRepoMemberAction: runMemberAction
  })
})

afterEach(cleanup)

describe('MultiRepoMemberDeleteNote', () => {
  it('says only that repo goes and how many the workspace keeps', () => {
    const { container } = render(<MultiRepoMemberDeleteNote worktreeId="wt-b" />)
    expect(container.textContent).toBe('Only deletes web. The workspace keeps 2 repos.')
  })

  it('renders nothing for a worktree that is not a member', () => {
    const { container } = render(<MultiRepoMemberDeleteNote worktreeId="wt-other" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('RemoveFromWorkspaceMenuItem', () => {
  function renderMenu(worktreeId: string) {
    return render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RemoveFromWorkspaceMenuItem worktreeId={worktreeId} />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  it('detaches the member and offers Undo that attaches it back', async () => {
    runMemberAction.mockResolvedValue(workspace)
    renderMenu('wt-b')
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from workspace' }))
    })
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(runMemberAction).toHaveBeenCalledWith('detachMember', {
      folderWorkspaceId: 'f1',
      memberId: 'b',
      executionHostId: 'local'
    })
    const options = toast.mock.calls[0][1]
    expect(toast.mock.calls[0][0]).toBe('web left checkout-flow')
    await act(async () => {
      options.action.onClick()
    })
    expect(runMemberAction).toHaveBeenLastCalledWith('attachMember', {
      folderWorkspaceId: 'f1',
      memberId: 'b',
      executionHostId: 'local'
    })
  })

  it('removes and undoes against the host adoption stamped on a remote runtime workspace', async () => {
    runMemberAction.mockResolvedValue(workspace)
    useAppStore.setState({ folderWorkspaces: [{ ...workspace, executionHostId: 'runtime:env-a' }] })
    renderMenu('wt-b')
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from workspace' }))
    })
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(runMemberAction).toHaveBeenCalledWith('detachMember', {
      folderWorkspaceId: 'f1',
      memberId: 'b',
      executionHostId: 'runtime:env-a'
    })
    await act(async () => {
      toast.mock.calls[0][1].action.onClick()
    })
    expect(runMemberAction).toHaveBeenLastCalledWith('attachMember', {
      folderWorkspaceId: 'f1',
      memberId: 'b',
      executionHostId: 'runtime:env-a'
    })
  })

  it('is absent for a worktree that is not a member', () => {
    renderMenu('wt-other')
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
