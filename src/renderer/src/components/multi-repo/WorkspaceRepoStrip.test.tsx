// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import WorkspaceRepoStrip from './WorkspaceRepoStrip'

const mocks = vi.hoisted(() => ({ activate: vi.fn() }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: mocks.activate }))

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
        attempts: 0,
        worktreeId: 'wt-a'
      }
    ]
  }
}

beforeEach(() => {
  mocks.activate.mockReset()
  useAppStore.setState({
    folderWorkspaces: [workspace],
    activeWorktreeId: 'folder:f1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the strip reads only displayName.
    repos: [{ id: 'repo-a', displayName: 'api' } as Repo],
    gitStatusByWorktree: {}
  })
})

afterEach(cleanup)

describe('WorkspaceRepoStrip', () => {
  it('marks the active destination and activates a repo with one click', () => {
    const { getByRole, getByText } = render(<WorkspaceRepoStrip />)
    const nav = getByRole('navigation')
    expect(nav.getAttribute('aria-label')).toBe('Repos in checkout-flow')
    expect(getByText('All').closest('button')?.getAttribute('aria-current')).toBe('page')
    act(() => {
      getByText('api').click()
    })
    expect(mocks.activate).toHaveBeenCalledWith('wt-a', {
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
  })

  it('renders nothing outside a multi-repo workspace', () => {
    useAppStore.setState({ activeWorktreeId: 'wt-other' })
    const { container } = render(<WorkspaceRepoStrip />)
    expect(container.firstChild).toBeNull()
  })
})
