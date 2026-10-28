// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { MultiRepoMember } from '../../../../shared/multi-repo-workspace'
import MultiRepoWorkspaceRootPanel from './MultiRepoWorkspaceRootPanel'

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function workspace(members: MultiRepoMember[]): FolderWorkspace {
  return {
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
    multiRepo: { version: 1, executionHostId: 'local', rootOwnedByOrca: true, members }
  }
}

const openModal = vi.fn()
const runMemberAction = vi.fn()

beforeEach(() => {
  openModal.mockReset()
  runMemberAction.mockReset()
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the panel reads only repo ids and names.
    repos: [{ id: 'repo-a', displayName: 'api' }] as never,
    worktreesByRepo: {},
    gitStatusByWorktree: {},
    openModal,
    runMultiRepoMemberAction: runMemberAction
  })
})

afterEach(cleanup)

describe('MultiRepoWorkspaceRootPanel', () => {
  it('offers Delete workspace in the empty state, through the multi-repo dialog', () => {
    const ws = workspace([])
    useAppStore.setState({ folderWorkspaces: [ws] })
    render(<MultiRepoWorkspaceRootPanel folderWorkspace={ws} />)
    expect(screen.getByText('No repos in this workspace')).toBeTruthy()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    })
    expect(openModal).toHaveBeenCalledWith('delete-multi-repo-workspace', {
      folderWorkspaceId: 'f1',
      executionHostId: 'local'
    })
  })

  it('retries only the failed repo and explains it is not created yet', async () => {
    runMemberAction.mockResolvedValue(undefined)
    const ws = workspace([
      {
        memberId: 'a',
        repoId: 'repo-a',
        dirName: 'api',
        branchName: 'flow',
        state: 'failed',
        attempts: 1,
        failure: { code: 'git_failed', message: 'fetch failed', at: 1 }
      }
    ])
    useAppStore.setState({ folderWorkspaces: [ws] })
    render(<MultiRepoWorkspaceRootPanel folderWorkspace={ws} />)
    expect(screen.getByText('Git could not create it').getAttribute('title')).toBe('fetch failed')
    expect(
      screen.getByText('api not created yet. The workspace folder holds only the ready repos.')
    ).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(runMemberAction).toHaveBeenCalledWith('retryMember', {
      folderWorkspaceId: 'f1',
      memberId: 'a',
      executionHostId: 'local'
    })
  })

  it('retries against the host adoption stamped on a remote runtime workspace', async () => {
    runMemberAction.mockResolvedValue(undefined)
    const ws = {
      ...workspace([
        {
          memberId: 'a',
          repoId: 'repo-a',
          dirName: 'api',
          branchName: 'flow',
          state: 'failed' as const,
          attempts: 1,
          failure: { code: 'git_failed' as const, message: 'fetch failed', at: 1 }
        }
      ]),
      executionHostId: 'runtime:env-a' as const
    }
    useAppStore.setState({ folderWorkspaces: [ws] })
    render(<MultiRepoWorkspaceRootPanel folderWorkspace={ws} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(runMemberAction).toHaveBeenCalledWith('retryMember', {
      folderWorkspaceId: 'f1',
      memberId: 'a',
      executionHostId: 'runtime:env-a'
    })
  })
})
