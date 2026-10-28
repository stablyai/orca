// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { MultiRepoMember } from '../../../../shared/multi-repo-workspace'
import MultiRepoAttentionRows from './MultiRepoAttentionRows'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function member(id: string, patch: Partial<MultiRepoMember> = {}): MultiRepoMember {
  return {
    memberId: id,
    repoId: `repo-${id}`,
    dirName: id,
    branchName: 'flow',
    state: 'ready',
    attempts: 1,
    worktreeId: `wt-${id}`,
    ...patch
  }
}

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

const runMemberAction = vi.fn()

beforeEach(() => {
  runMemberAction.mockReset()
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only repo ids and names.
    repos: ['a', 'b'].map((id) => ({
      id: `repo-${id}`,
      displayName: id === 'a' ? 'api' : 'web'
    })) as never,
    worktreesByRepo: {},
    runMultiRepoMemberAction: runMemberAction
  })
})

afterEach(cleanup)

describe('MultiRepoAttentionRows', () => {
  it('renders nothing while every repo is ready', () => {
    const { container } = render(
      <MultiRepoAttentionRows folderWorkspace={workspace([member('a', { state: 'ready' })])} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists a failed repo with its reason and retries only that repo', async () => {
    runMemberAction.mockResolvedValue(undefined)
    render(
      <MultiRepoAttentionRows
        folderWorkspace={workspace([
          member('a', {
            state: 'failed',
            worktreeId: undefined,
            failure: { code: 'git_failed', message: 'fetch failed', at: 1 }
          }),
          member('b', { state: 'creating', worktreeId: undefined })
        ])}
      />
    )
    expect(screen.getByText('Git could not create it').getAttribute('title')).toBe('fetch failed')
    expect(screen.getByText('Creating…')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry api' }))
    })
    expect(runMemberAction).toHaveBeenCalledWith('retryMember', {
      folderWorkspaceId: 'f1',
      memberId: 'a',
      executionHostId: 'local'
    })
  })

  it('retries against the host adoption stamped on a remote runtime workspace', async () => {
    runMemberAction.mockResolvedValue(undefined)
    render(
      <MultiRepoAttentionRows
        folderWorkspace={{
          ...workspace([member('a', { state: 'interrupted', worktreeId: undefined })]),
          executionHostId: 'runtime:env-a'
        }}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry api' }))
    })
    expect(runMemberAction).toHaveBeenCalledWith('retryMember', {
      folderWorkspaceId: 'f1',
      memberId: 'a',
      executionHostId: 'runtime:env-a'
    })
  })

  it('offers Retry for an interrupted repo', () => {
    render(
      <MultiRepoAttentionRows
        folderWorkspace={workspace([member('b', { state: 'interrupted', worktreeId: undefined })])}
      />
    )
    expect(screen.getByText('Interrupted')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry web' })).toBeTruthy()
  })
})
