import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace } from '../sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import type { Repo } from '../../../../shared/repo-types'

const { storeState, supportsExact, toastSuccess, toastError } = vi.hoisted(() => {
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
    supportsExact: vi.fn<() => Promise<boolean>>(),
    toastSuccess: vi.fn(),
    toastError: vi.fn()
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/rpc/compatibility/runtime-target-capability', () => ({
  runtimeTargetSupportsCapability: supportsExact
}))
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
    supportsExact.mockReset().mockResolvedValue(true)
    toastSuccess.mockReset()
    toastError.mockReset()
  })

  it('asks the host for exactly the folder name, in place', async () => {
    await createFolderRepoWorktree(folder, repo)

    const call = storeState.createWorktree.mock.calls[0] ?? []
    expect([call[0], call[1], call.at(-1)]).toEqual([
      'repo-api',
      'Login fix',
      { executionHostId: 'local', branchIntent: 'create-exact' }
    ])
    expect(storeState.openModal).not.toHaveBeenCalled()
  })

  it('opens the composer on the clicked host and creates nothing when the host predates exact names', async () => {
    supportsExact.mockResolvedValue(false)

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

  it.each([
    [
      'Electron IPC',
      new Error(
        'Error invoking remote method \'worktrees:create\': WorktreeCreateExactNameTakenError: "Login fix" is already taken on this host. Nothing was created.\nworktree_create_exact_name_taken'
      )
    ],
    [
      'runtime RPC',
      Object.assign(new Error('"Login fix" is already taken on this host.'), {
        code: 'worktree_create_exact_name_taken'
      })
    ]
  ])('opens the composer when the name is taken (%s)', async (_, error) => {
    storeState.createWorktree.mockRejectedValue(error)

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({ initialRepoId: 'repo-api', prefilledName: 'Login fix' })
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows a timeout as an error and does not create again', async () => {
    storeState.createWorktree.mockRejectedValue(new Error('git timed out.'))

    await createFolderRepoWorktree(folder, repo)

    expect(toastError).toHaveBeenCalledWith('git timed out.')
    expect(storeState.createWorktree.mock.calls).toHaveLength(1)
    expect(storeState.openModal).not.toHaveBeenCalled()
  })

  it.each([
    [
      "Error invoking remote method 'worktrees:create': Error: Setup decision required for this repository"
    ],
    ['Setup decision required for this repository']
  ])('opens the composer when the repository asks before running setup (%s)', async (message) => {
    storeState.createWorktree.mockRejectedValue(new Error(message))

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({ initialRepoId: 'repo-api', prefilledName: 'Login fix' })
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it.each([
    ['setup', 'Setup decision required for this repository'],
    ['exact-name', '"Login fix" is already taken.\nworktree_create_exact_name_taken']
  ])(
    'opens nothing when the %s refusal arrives after the user left the folder',
    async (_, message) => {
      storeState.createWorktree.mockImplementation(async () => {
        storeState.activeWorkspaceKey = 'folder:other'
        throw new Error(message)
      })

      await createFolderRepoWorktree(folder, repo)

      expect(storeState.openModal).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['another folder', { activeWorkspaceKey: 'folder:other' }],
    ['the same folder id on another host', { activeWorkspaceExecutionHostId: 'runtime:env-b' }]
  ])('creates nothing when the user moved to %s during the host check', async (_, moved) => {
    supportsExact.mockImplementation(async () => {
      Object.assign(storeState, moved)
      return true
    })

    await createFolderRepoWorktree(folder, repo)

    expect(storeState.createWorktree).not.toHaveBeenCalled()
    expect(storeState.openModal).not.toHaveBeenCalled()
  })

  it('starts one create when a second panel asks for the same repository mid-create', async () => {
    let finishCheck: (supported: boolean) => void = () => {}
    supportsExact.mockImplementation(() => new Promise((resolve) => (finishCheck = resolve)))

    const first = createFolderRepoWorktree(folder, repo)
    const second = createFolderRepoWorktree(folder, repo)
    finishCheck(true)
    await Promise.all([first, second])

    expect(storeState.createWorktree.mock.calls).toHaveLength(1)
  })
})
