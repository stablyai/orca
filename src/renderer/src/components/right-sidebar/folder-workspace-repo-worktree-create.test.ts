import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace } from '../sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import type { Repo } from '../../../../shared/repo-types'

const { storeState, searchRefs, toastSuccess, toastError } = vi.hoisted(() => ({
  storeState: {
    activeWorkspaceKey: 'folder:folder-workspace-1' as string | null,
    createWorktree: vi.fn(),
    openModal: vi.fn()
  },
  searchRefs: vi.fn<() => Promise<string[]>>(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/runtime-repo-client', () => ({ searchRuntimeRepoBaseRefs: searchRefs }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

import { createFolderRepoWorktree } from './folder-workspace-repo-worktree-create'

const folder = makeFolderWorkspace({ name: 'Login fix' })
const repo: Repo = {
  id: 'repo-api',
  path: '/repo/platform/api',
  displayName: 'api',
  badgeColor: 'blue',
  addedAt: 1
}

describe('createFolderRepoWorktree', () => {
  beforeEach(() => {
    storeState.activeWorkspaceKey = 'folder:folder-workspace-1'
    storeState.createWorktree.mockReset().mockResolvedValue({})
    storeState.openModal.mockReset()
    searchRefs.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
  })

  it('creates the worktree in place when no branch has its name', async () => {
    searchRefs.mockResolvedValue(['origin/main', 'origin/Login-fix-old'])

    await createFolderRepoWorktree(folder, repo)

    expect(searchRefs).toHaveBeenCalledWith('local', 'repo-api', 'Login-fix', 50)
    expect(storeState.createWorktree).toHaveBeenCalledTimes(1)
    expect(storeState.createWorktree.mock.calls[0]?.slice(0, 2)).toEqual(['repo-api', 'Login fix'])
    expect(storeState.openModal).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it.each([['origin/login-fix'], ['brennan/Login-fix']])(
    'opens the prefilled composer when %s exists',
    async (ref) => {
      searchRefs.mockResolvedValue(['origin/main', ref])

      await createFolderRepoWorktree(folder, repo)

      expect(storeState.createWorktree).not.toHaveBeenCalled()
      expect(storeState.openModal).toHaveBeenCalledWith('new-workspace-composer', {
        initialRepoId: 'repo-api',
        prefilledName: 'Login fix',
        telemetrySource: 'sidebar'
      })
    }
  )

  it('creates nothing when the user left the folder during the branch check', async () => {
    searchRefs.mockImplementation(async () => {
      storeState.activeWorkspaceKey = 'folder:other'
      return []
    })

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.createWorktree).not.toHaveBeenCalled()
    expect(storeState.openModal).not.toHaveBeenCalled()
  })
})
