import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { DevcontainerInfo } from '../../../../shared/devcontainer-types'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  storeState: {
    addRepoPath: vi.fn(),
    updateRepo: vi.fn(),
    removeProject: vi.fn()
  },
  onRepoReady: vi.fn(),
  onDone: vi.fn(),
  setIsAdding: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState)
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-devcontainer',
    path: '/Users/me/work/aprium',
    displayName: 'aprium',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeInfo(hostFolder = '/Users/me/work/aprium'): DevcontainerInfo {
  return {
    containerId: 'cid-1',
    name: 'aprium-dev',
    hostFolder,
    configFile: `${hostFolder}/.devcontainer/devcontainer.json`,
    running: true,
    mounts: [{ source: hostFolder, destination: '/workspaces/aprium' }]
  }
}

describe('useAddRepoDevcontainerFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes a successful devcontainer selection through the normal completion path', async () => {
    const repo = makeRepo()
    mocks.storeState.addRepoPath.mockResolvedValue(repo)
    mocks.storeState.updateRepo.mockResolvedValue(true)
    mocks.onRepoReady.mockResolvedValue(undefined)
    const { useAddRepoDevcontainerFlow } = await import('./useAddRepoDevcontainerFlow')

    const result = useAddRepoDevcontainerFlow({
      setIsAdding: mocks.setIsAdding,
      onRepoReady: mocks.onRepoReady,
      onDone: mocks.onDone
    })
    await result.handleSelectDevcontainer(makeInfo())

    expect(mocks.storeState.addRepoPath).toHaveBeenCalledWith('/Users/me/work/aprium', 'git')
    expect(mocks.storeState.updateRepo).toHaveBeenCalledWith(repo.id, {
      executionHostId: 'devcontainer:%2FUsers%2Fme%2Fwork%2Faprium',
      connectionId: 'devcontainer:%2FUsers%2Fme%2Fwork%2Faprium',
      worktreeBasePath: '.worktrees'
    })
    expect(mocks.storeState.removeProject).not.toHaveBeenCalled()
    expect(mocks.onRepoReady).toHaveBeenCalledWith(repo.id)
    expect(mocks.onDone).toHaveBeenCalled()
    expect(mocks.setIsAdding).toHaveBeenNthCalledWith(1, true)
    expect(mocks.setIsAdding).toHaveBeenLastCalledWith(false)
  })

  it('rolls back a transient repo when routing updateRepo fails', async () => {
    const repo = makeRepo()
    mocks.storeState.addRepoPath.mockResolvedValue(repo)
    mocks.storeState.updateRepo.mockResolvedValue(false)
    const { useAddRepoDevcontainerFlow } = await import('./useAddRepoDevcontainerFlow')

    const result = useAddRepoDevcontainerFlow({
      setIsAdding: mocks.setIsAdding,
      onRepoReady: mocks.onRepoReady,
      onDone: mocks.onDone
    })
    await result.handleSelectDevcontainer(makeInfo())

    expect(mocks.storeState.removeProject).toHaveBeenCalledWith(repo.id)
    expect(mocks.onRepoReady).not.toHaveBeenCalled()
    expect(mocks.onDone).not.toHaveBeenCalled()
  })

  it('rolls back a transient repo when routing updateRepo rejects', async () => {
    const repo = makeRepo()
    mocks.storeState.addRepoPath.mockResolvedValue(repo)
    mocks.storeState.updateRepo.mockRejectedValue(new Error('disk full'))
    const { useAddRepoDevcontainerFlow } = await import('./useAddRepoDevcontainerFlow')

    const result = useAddRepoDevcontainerFlow({
      setIsAdding: mocks.setIsAdding,
      onRepoReady: mocks.onRepoReady,
      onDone: mocks.onDone
    })
    await result.handleSelectDevcontainer(makeInfo())

    expect(mocks.storeState.removeProject).toHaveBeenCalledWith(repo.id)
    expect(mocks.onRepoReady).not.toHaveBeenCalled()
    expect(mocks.onDone).not.toHaveBeenCalled()
  })
})
