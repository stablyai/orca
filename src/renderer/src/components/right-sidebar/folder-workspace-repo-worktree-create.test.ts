import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace } from '../sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import type { Repo } from '../../../../shared/repo-types'

const { storeState, searchRefs, toastSuccess, toastError } = vi.hoisted(() => {
  const storeState: {
    activeWorkspaceKey: string | null
    activeWorkspaceExecutionHostId: string | null
    projectHostSetups: never[]
    createWorktree: ReturnType<typeof vi.fn>
    openModal: ReturnType<typeof vi.fn>
  } = {
    activeWorkspaceKey: 'folder:folder-workspace-1',
    activeWorkspaceExecutionHostId: null,
    projectHostSetups: [],
    createWorktree: vi.fn(),
    openModal: vi.fn()
  }
  return {
    storeState,
    searchRefs: vi.fn<() => Promise<string[]>>(),
    toastSuccess: vi.fn(),
    toastError: vi.fn()
  }
})
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
    storeState.activeWorkspaceExecutionHostId = null
    storeState.createWorktree.mockReset().mockResolvedValue({})
    storeState.openModal.mockReset()
    searchRefs.mockReset().mockResolvedValue([])
    toastSuccess.mockReset()
    toastError.mockReset()
  })

  it('creates the worktree in place when no branch has its name', async () => {
    searchRefs.mockResolvedValue(['origin/main', 'origin/Login-fix-old'])

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.createWorktree.mock.calls[0]?.slice(0, 2)).toEqual(['repo-api', 'Login fix'])
    expect(storeState.openModal).not.toHaveBeenCalled()
  })

  it('opens the composer on the clicked host when the branch exists', async () => {
    searchRefs.mockResolvedValue(['origin/main', 'brennan/Login-fix'])

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.createWorktree).not.toHaveBeenCalled()
    expect(storeState.openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        initialRepoId: 'repo-api',
        initialWorkspaceTarget: expect.objectContaining({ hostId: 'local' }),
        prefilledName: 'Login fix'
      })
    )
  })

  it('opens the composer when the repository asks before running setup', async () => {
    storeState.createWorktree.mockRejectedValue(
      new Error('Setup decision required for this repository')
    )

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({ initialRepoId: 'repo-api', prefilledName: 'Login fix' })
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it.each([
    ['another folder', { activeWorkspaceKey: 'folder:other' }],
    ['the same folder id on another host', { activeWorkspaceExecutionHostId: 'runtime:env-b' }]
  ])('creates nothing when the user moved to %s during the branch check', async (_, moved) => {
    searchRefs.mockImplementation(async () => {
      Object.assign(storeState, moved)
      return []
    })

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.createWorktree).not.toHaveBeenCalled()
    expect(storeState.openModal).not.toHaveBeenCalled()
  })

  it('starts one create when a second panel asks for the same repository mid-create', async () => {
    let finishSearch: (refs: string[]) => void = () => {}
    searchRefs.mockImplementation(() => new Promise((resolve) => (finishSearch = resolve)))

    const first = createFolderRepoWorktree(folder, repo)
    const second = createFolderRepoWorktree(folder, repo)
    finishSearch([])
    await Promise.all([first, second])

    expect(storeState.createWorktree.mock.calls).toHaveLength(1)
  })
})
