import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addRepoPath: vi.fn(),
  fetchWorktrees: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  storeState: {} as Record<string, unknown>
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import {
  openLaunchedWorkspacePaths,
  registerLaunchedWorkspacePathIpcBridge
} from './launched-workspace-path-ipc-bridge'

/** Resets the fake store state, optionally seeding worktrees by repo id. */
function givenStore(worktreesByRepo: Record<string, unknown[]> = {}): void {
  mocks.storeState = {
    addRepoPath: mocks.addRepoPath,
    fetchWorktrees: mocks.fetchWorktrees,
    worktreesByRepo
  }
}

describe('openLaunchedWorkspacePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    givenStore()
  })

  it('adds the folder as a git project and reveals its main worktree', async () => {
    const repo = { id: 'repo-1', kind: 'git' }
    const mainWorktree = { id: 'wt-main', isMainWorktree: true }
    const sideWorktree = { id: 'wt-side', isMainWorktree: false }
    mocks.addRepoPath.mockResolvedValue(repo)
    mocks.fetchWorktrees.mockImplementation(async () => {
      mocks.storeState.worktreesByRepo = { 'repo-1': [sideWorktree, mainWorktree] }
    })

    await openLaunchedWorkspacePaths(['/repos/alpha'])

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/repos/alpha', 'git')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-main', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('falls back to the first worktree when no main worktree exists', async () => {
    const repo = { id: 'repo-2', kind: 'git' }
    const onlyWorktree = { id: 'wt-only', isMainWorktree: false }
    mocks.addRepoPath.mockResolvedValue(repo)
    mocks.fetchWorktrees.mockImplementation(async () => {
      mocks.storeState.worktreesByRepo = { 'repo-2': [onlyWorktree] }
    })

    await openLaunchedWorkspacePaths(['/repos/beta'])

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-only', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('skips reveal for non-git folders without fetching worktrees', async () => {
    const folderRepo = { id: 'repo-3', kind: 'folder' }
    mocks.addRepoPath.mockResolvedValue(folderRepo)

    await openLaunchedWorkspacePaths(['/srv/plain-folder'])

    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('skips reveal when the project was already added and the action returned null', async () => {
    mocks.addRepoPath.mockResolvedValue(null)

    await openLaunchedWorkspacePaths(['/repos/duplicate'])

    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('keeps opening later paths when an earlier one fails', async () => {
    const repo = { id: 'repo-4', kind: 'folder' }
    mocks.addRepoPath.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(repo)

    await openLaunchedWorkspacePaths(['/repos/bad', '/repos/good'])

    expect(mocks.addRepoPath).toHaveBeenCalledTimes(2)
  })

  it('subscribes to pushed launches before signalling bridge readiness', () => {
    const calls: string[] = []
    vi.stubGlobal('window', {
      api: {
        ui: {
          onOpenWorkspacePath: () => {
            calls.push('subscribe')
            return () => {}
          },
          notifyWorkspacePathBridgeReady: () => {
            calls.push('ready')
          }
        }
      }
    })
    const unsubscribers: (() => void)[] = []
    registerLaunchedWorkspacePathIpcBridge(unsubscribers)

    expect(calls).toEqual(['subscribe', 'ready'])
    expect(unsubscribers).toHaveLength(1)
    vi.unstubAllGlobals()
  })
})
